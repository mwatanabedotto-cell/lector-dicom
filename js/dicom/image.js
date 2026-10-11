/*
 * Construccion del objeto imagen y pipeline de presentacion.
 *
 * Un "image" es la unidad que dibuja el viewport. Contiene los valores
 * almacenados (stored values) en un typed array, mas los descriptores
 * necesarios para convertirlos a unidades reales y a pixeles en pantalla:
 *
 *   stored value --[slope/intercept]--> valor modalidad (HU en TC)
 *                --[window/level]-----> 0..255 en pantalla
 *
 * La ventana se aplica con una LUT precalculada indexada por stored value,
 * que es lo que permite repintar 512x512 sin coste apreciable.
 */
(function (global) {
  'use strict';

  var DCM = global.DCM = global.DCM || {};

  // Presets de ventana para TC, en unidades Hounsfield.
  var PRESETS = [
    { id: 'auto', label: 'Auto (min/max)', ww: null, wc: null },
    { id: 'default', label: 'Del fichero', ww: null, wc: null },
    { id: 'lung', label: 'Pulmon', ww: 1500, wc: -600 },
    { id: 'mediastinum', label: 'Mediastino', ww: 350, wc: 50 },
    { id: 'abdomen', label: 'Abdomen / partes blandas', ww: 400, wc: 50 },
    { id: 'liver', label: 'Higado', ww: 150, wc: 60 },
    { id: 'bone', label: 'Hueso', ww: 2000, wc: 350 },
    { id: 'brain', label: 'Cerebro', ww: 80, wc: 40 },
    { id: 'posterior-fossa', label: 'Fosa posterior', ww: 120, wc: 60 },
    { id: 'stroke', label: 'Ictus', ww: 40, wc: 35 },
    { id: 'angio', label: 'Angio', ww: 600, wc: 300 },
    { id: 'spine', label: 'Columna', ww: 250, wc: 50 }
  ];

  function arrayFor(bitsAllocated, signed, length) {
    if (bitsAllocated <= 8) return signed ? new Int8Array(length) : new Uint8Array(length);
    if (bitsAllocated <= 16) return signed ? new Int16Array(length) : new Uint16Array(length);
    return signed ? new Int32Array(length) : new Uint32Array(length);
  }

  /**
   * Convierte bytes crudos en stored values normalizados.
   * Aplica el desplazamiento por HighBit y la extension de signo cuando
   * BitsStored < BitsAllocated.
   */
  function normalizePixels(bytes, info) {
    var count = info.rows * info.columns * info.samplesPerPixel;
    var signed = info.pixelRepresentation === 1;
    var bits = info.bitsAllocated;

    if (bits === 1) {
      // Imagen binaria empaquetada, bit menos significativo primero.
      var bin = new Uint8Array(count);
      for (var b = 0; b < count; b++) {
        bin[b] = (bytes[b >> 3] >> (b & 7)) & 1;
      }
      return bin;
    }

    var bytesPerSample = bits / 8;
    var unusedLow = info.highBit + 1 - info.bitsStored;
    if (unusedLow < 0) unusedLow = 0;
    var needsShift = unusedLow !== 0 || info.bitsStored !== bits;

    // Vista sobre los bytes de origen. Se copia si el offset no esta alineado,
    // porque los typed arrays de 16/32 bits exigen alineacion.
    var source;
    var aligned = (bytes.byteOffset % bytesPerSample) === 0;
    var usable = Math.floor(bytes.byteLength / bytesPerSample);
    var buffer = aligned ? bytes.buffer : bytes.slice().buffer;
    var offset = aligned ? bytes.byteOffset : 0;

    if (bytesPerSample === 1) {
      source = new Uint8Array(buffer, offset, usable);
    } else if (bytesPerSample === 2) {
      source = new Uint16Array(buffer, offset, usable);
    } else {
      source = new Uint32Array(buffer, offset, usable);
    }

    var out = arrayFor(bits, signed, count);
    var n = Math.min(count, source.length);

    if (!needsShift) {
      // Camino rapido: los stored values ya ocupan toda la palabra.
      // Un Int16Array sobre datos unsigned extiende el signo solo.
      out.set(source.subarray(0, n));
      if (n < count) out.fill(0, n);
      return out;
    }

    var mask = info.bitsStored >= 32 ? 0xFFFFFFFF : ((1 << info.bitsStored) - 1);
    if (signed) {
      var shift = 32 - info.bitsStored;
      for (var i = 0; i < n; i++) {
        out[i] = (((source[i] >>> unusedLow) & mask) << shift) >> shift;
      }
    } else {
      for (var j = 0; j < n; j++) {
        out[j] = (source[j] >>> unusedLow) & mask;
      }
    }
    return out;
  }

  function minMax(pixels) {
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < pixels.length; i++) {
      var v = pixels[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === Infinity) { min = 0; max = 0; }
    return { min: min, max: max };
  }

  /** Busca un valor en los functional groups de un multiframe mejorado. */
  function fromFunctionalGroups(dataset, frameIndex, sequenceTag, tag) {
    var perFrame = dataset.sequence('52009230');
    if (perFrame.length) {
      var frame = perFrame[Math.min(frameIndex, perFrame.length - 1)];
      var sub = frame.item(sequenceTag);
      if (sub && sub.has(tag)) return sub;
    }
    var shared = dataset.item('52009229');
    if (shared) {
      var sharedSub = shared.item(sequenceTag);
      if (sharedSub && sharedSub.has(tag)) return sharedSub;
    }
    return null;
  }

  function readGeometry(dataset, frameIndex) {
    var geometry = {
      rowSpacing: 1,
      colSpacing: 1,
      sliceThickness: undefined,
      spacingBetweenSlices: undefined,
      position: null,
      orientation: null,
      sliceLocation: undefined,
      hasRealSpacing: false
    };

    var spacing = dataset.strings('00280030').map(parseFloat);
    if (spacing.length < 2) {
      var measures = fromFunctionalGroups(dataset, frameIndex, '00289110', '00280030');
      if (measures) spacing = measures.strings('00280030').map(parseFloat);
    }
    if (spacing.length >= 2 && isFinite(spacing[0]) && isFinite(spacing[1])) {
      // PixelSpacing es [espaciado entre filas, espaciado entre columnas].
      geometry.rowSpacing = spacing[0];
      geometry.colSpacing = spacing[1];
      geometry.hasRealSpacing = true;
    } else {
      // Sin PixelSpacing real, PixelAspectRatio al menos corrige la forma.
      var aspect = dataset.strings('00280034').map(parseFloat);
      if (aspect.length === 2 && aspect[0] > 0 && aspect[1] > 0) {
        geometry.rowSpacing = aspect[0];
        geometry.colSpacing = aspect[1];
      }
    }

    geometry.sliceThickness = dataset.number('00180050');
    geometry.spacingBetweenSlices = dataset.number('00180088');
    geometry.sliceLocation = dataset.number('00201041');

    var position = dataset.numbers('00200032');
    if (position.length < 3) {
      var planePos = fromFunctionalGroups(dataset, frameIndex, '00209113', '00200032');
      if (planePos) position = planePos.numbers('00200032');
    }
    if (position.length >= 3) geometry.position = position.slice(0, 3);

    var orientation = dataset.numbers('00200037');
    if (orientation.length < 6) {
      var planeOrient = fromFunctionalGroups(dataset, frameIndex, '00209116', '00200037');
      if (planeOrient) orientation = planeOrient.numbers('00200037');
    }
    if (orientation.length >= 6) geometry.orientation = orientation.slice(0, 6);

    return geometry;
  }

  function readPalette(dataset) {
    if (!dataset.has('00281201')) return null;
    var descriptor = dataset.numbers('00281101');
    if (descriptor.length < 3) return null;
    var entries = descriptor[0] === 0 ? 65536 : descriptor[0];
    var firstMapped = descriptor[1];
    var bits = descriptor[2];

    function channel(tag) {
      var raw = dataset.raw(tag);
      if (!raw) return null;
      if (bits === 8) return raw;
      var out = new Uint8Array(entries);
      var view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      for (var i = 0; i < entries && i * 2 + 1 < raw.byteLength; i++) {
        // Se toma el byte alto para bajar de 16 a 8 bits de presentacion.
        out[i] = view.getUint16(i * 2, dataset.littleEndian) >> 8;
      }
      return out;
    }

    var red = channel('00281201');
    var green = channel('00281202');
    var blue = channel('00281203');
    if (!red || !green || !blue) return null;
    return { entries: entries, firstMapped: firstMapped, red: red, green: green, blue: blue };
  }

  /**
   * Construye el objeto imagen de un frame.
   * `parsed` es la salida de DCM.parse.
   */
  DCM.buildImage = async function (parsed, frameIndex) {
    var ds = parsed.dataset;
    frameIndex = frameIndex || 0;

    var rows = ds.number('00280010');
    var columns = ds.number('00280011');
    if (!rows || !columns) {
      throw new Error('El fichero no declara Rows/Columns: no es una imagen.');
    }

    var info = {
      rows: rows,
      columns: columns,
      samplesPerPixel: ds.number('00280002', 1),
      bitsAllocated: ds.number('00280100', 16),
      bitsStored: ds.number('00280101', 0),
      highBit: ds.number('00280102', 0),
      pixelRepresentation: ds.number('00280103', 0),
      planarConfiguration: ds.number('00280006', 0),
      photometricInterpretation: ds.string('00280004', 'MONOCHROME2').toUpperCase(),
      frameCount: Math.max(1, parseInt(ds.string('00280008', '1'), 10) || 1)
    };
    if (!info.bitsStored) info.bitsStored = info.bitsAllocated;
    if (!ds.has('00280102')) info.highBit = info.bitsStored - 1;

    var decoded = await DCM.decoders.getFrameBytes(parsed, info, frameIndex);

    // Un decoder puede cambiar los descriptores (p.ej. JPEG a 8 bits).
    ['bitsAllocated', 'bitsStored', 'highBit', 'pixelRepresentation',
     'planarConfiguration', 'photometricInterpretation'].forEach(function (key) {
      if (decoded[key] !== undefined) info[key] = decoded[key];
    });

    var pixels = normalizePixels(decoded.bytes, info);
    var range = minMax(pixels);
    var geometry = readGeometry(ds, frameIndex);

    var slope = ds.number('00281053');
    var intercept = ds.number('00281052');
    if (slope === undefined) {
      var transform = fromFunctionalGroups(ds, frameIndex, '00289145', '00281053');
      if (transform) {
        slope = transform.number('00281053');
        intercept = transform.number('00281052');
      }
    }
    if (slope === undefined || slope === 0) slope = 1;
    if (intercept === undefined) intercept = 0;

    var windowWidths = ds.strings('00281051').map(parseFloat).filter(isFinite);
    var windowCenters = ds.strings('00281050').map(parseFloat).filter(isFinite);
    if (!windowWidths.length) {
      var voi = fromFunctionalGroups(ds, frameIndex, '00289132', '00281051');
      if (voi) {
        windowWidths = voi.strings('00281051').map(parseFloat).filter(isFinite);
        windowCenters = voi.strings('00281050').map(parseFloat).filter(isFinite);
      }
    }

    var image = {
      // Identificacion
      sopInstanceUID: ds.string('00080018', ''),
      seriesInstanceUID: ds.string('0020000E', ''),
      studyInstanceUID: ds.string('0020000D', ''),
      instanceNumber: ds.number('00200013'),
      modality: ds.string('00080060', ''),
      frameIndex: frameIndex,
      frameCount: info.frameCount,

      // Pixeles
      pixels: pixels,
      rows: info.rows,
      columns: info.columns,
      samplesPerPixel: info.samplesPerPixel,
      bitsAllocated: info.bitsAllocated,
      bitsStored: info.bitsStored,
      pixelRepresentation: info.pixelRepresentation,
      planarConfiguration: decoded.planarConfiguration !== undefined
        ? decoded.planarConfiguration : info.planarConfiguration,
      photometric: info.photometricInterpretation,
      palette: readPalette(ds),
      minStored: range.min,
      maxStored: range.max,

      // Transformacion de modalidad
      slope: slope,
      intercept: intercept,
      unit: ds.string('00281054', '') || (ds.string('00080060', '') === 'CT' ? 'HU' : ''),

      // VOI del fichero
      fileWindowWidth: windowWidths.length ? windowWidths[0] : undefined,
      fileWindowCenter: windowCenters.length ? windowCenters[0] : undefined,

      // Geometria
      rowSpacing: geometry.rowSpacing,
      colSpacing: geometry.colSpacing,
      hasRealSpacing: geometry.hasRealSpacing,
      sliceThickness: geometry.sliceThickness,
      spacingBetweenSlices: geometry.spacingBetweenSlices,
      position: geometry.position,
      orientation: geometry.orientation,
      sliceLocation: geometry.sliceLocation,

      // Procedencia
      transferSyntax: parsed.transferSyntax,
      approximate: !!decoded.approximate,
      approximateReason: decoded.approximateReason || null,

      _lutCache: null
    };

    return image;
  };

  /** Crea un objeto imagen sintetico (usado por las reconstrucciones MPR). */
  DCM.createImage = function (spec) {
    var range = spec.minStored === undefined ? minMax(spec.pixels)
      : { min: spec.minStored, max: spec.maxStored };
    return {
      synthetic: true,
      label: spec.label || '',
      pixels: spec.pixels,
      rows: spec.rows,
      columns: spec.columns,
      samplesPerPixel: 1,
      bitsAllocated: spec.pixels.BYTES_PER_ELEMENT * 8,
      bitsStored: spec.pixels.BYTES_PER_ELEMENT * 8,
      pixelRepresentation: (spec.pixels instanceof Int8Array ||
                            spec.pixels instanceof Int16Array ||
                            spec.pixels instanceof Int32Array) ? 1 : 0,
      planarConfiguration: 0,
      photometric: 'MONOCHROME2',
      palette: null,
      minStored: range.min,
      maxStored: range.max,
      slope: spec.slope !== undefined ? spec.slope : 1,
      intercept: spec.intercept !== undefined ? spec.intercept : 0,
      unit: spec.unit || '',
      fileWindowWidth: spec.fileWindowWidth,
      fileWindowCenter: spec.fileWindowCenter,
      rowSpacing: spec.rowSpacing,
      colSpacing: spec.colSpacing,
      hasRealSpacing: spec.hasRealSpacing !== false,
      sliceThickness: spec.sliceThickness,
      modality: spec.modality || '',
      approximate: false,
      approximateReason: null,
      _lutCache: null
    };
  };

  // ------------------------------------------------------ Valores y ventana

  var img = DCM.image = {};

  img.presets = PRESETS;

  /** stored value -> unidades de modalidad (HU en TC). */
  img.toModality = function (image, stored) {
    return stored * image.slope + image.intercept;
  };

  /** unidades de modalidad -> stored value. */
  img.fromModality = function (image, value) {
    return (value - image.intercept) / image.slope;
  };

  /** Valor de modalidad en (col, row). NaN si cae fuera. */
  img.valueAt = function (image, col, row) {
    col = Math.floor(col);
    row = Math.floor(row);
    if (col < 0 || row < 0 || col >= image.columns || row >= image.rows) return NaN;
    if (image.samplesPerPixel !== 1) return NaN;
    return img.toModality(image, image.pixels[row * image.columns + col]);
  };

  /** Ventana por defecto: la del fichero si existe, si no el rango real. */
  img.defaultWindow = function (image) {
    if (image.fileWindowWidth > 0 && image.fileWindowCenter !== undefined) {
      return { ww: image.fileWindowWidth, wc: image.fileWindowCenter };
    }
    return img.autoWindow(image);
  };

  /** Ventana ajustada al rango real de los datos. */
  img.autoWindow = function (image) {
    var min = img.toModality(image, image.minStored);
    var max = img.toModality(image, image.maxStored);
    if (image.slope < 0) { var t = min; min = max; max = t; }
    var ww = Math.max(1, max - min);
    return { ww: ww, wc: min + ww / 2 };
  };

  img.presetWindow = function (image, presetId) {
    if (presetId === 'auto') return img.autoWindow(image);
    if (presetId === 'default') return img.defaultWindow(image);
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].id === presetId && PRESETS[i].ww) {
        return { ww: PRESETS[i].ww, wc: PRESETS[i].wc };
      }
    }
    return img.defaultWindow(image);
  };

  function lutDomain(image) {
    var pixels = image.pixels;
    if (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) {
      return { size: 256, offset: 0 };
    }
    if (pixels instanceof Int8Array) return { size: 256, offset: 128 };
    if (pixels instanceof Uint16Array) return { size: 65536, offset: 0 };
    if (pixels instanceof Int16Array) return { size: 65536, offset: 32768 };
    return null; // 32 bits: demasiado grande para tabla, se calcula al vuelo
  }

  /**
   * LUT de stored value a gris de 8 bits, segun la funcion VOI LINEAR de
   * DICOM (PS3.3 C.11.2.1.2).
   */
  img.buildLut = function (image, ww, wc, invert) {
    var cached = image._lutCache;
    if (cached && cached.ww === ww && cached.wc === wc && cached.invert === invert) {
      return cached;
    }

    var domain = lutDomain(image);
    var monochrome1 = image.photometric === 'MONOCHROME1';
    var flip = (!!invert) !== monochrome1;
    var width = Math.max(1, ww);
    var low = wc - 0.5 - (width - 1) / 2;
    var scale = 255 / (width - 1 || 1);

    var result;
    if (!domain) {
      result = {
        ww: ww, wc: wc, invert: invert, table: null, offset: 0, flip: flip,
        compute: function (stored) {
          var value = stored * image.slope + image.intercept;
          var gray = (value - low) * scale;
          gray = gray < 0 ? 0 : (gray > 255 ? 255 : gray);
          return flip ? 255 - gray : gray;
        }
      };
    } else {
      var table = new Uint8ClampedArray(domain.size);
      for (var index = 0; index < domain.size; index++) {
        var stored = index - domain.offset;
        var value = stored * image.slope + image.intercept;
        var gray = (value - low) * scale;
        if (gray < 0) gray = 0; else if (gray > 255) gray = 255;
        table[index] = flip ? 255 - gray : gray;
      }
      result = {
        ww: ww, wc: wc, invert: invert, table: table, offset: domain.offset, flip: flip
      };
    }

    image._lutCache = result;
    return result;
  };

  function ybrToRgb(y, cb, cr, out, o) {
    out[o] = y + 1.402 * (cr - 128);
    out[o + 1] = y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128);
    out[o + 2] = y + 1.772 * (cb - 128);
  }

  /**
   * Escribe la imagen ya ventaneada en un ImageData del tamano de la imagen.
   */
  img.render = function (image, lut, imageData) {
    var data = imageData.data;
    var pixels = image.pixels;
    var count = image.rows * image.columns;
    var i, o;

    if (image.samplesPerPixel === 3) {
      var planar = image.planarConfiguration === 1;
      var ybr = image.photometric.indexOf('YBR') === 0;
      for (i = 0, o = 0; i < count; i++, o += 4) {
        var r, g, b;
        if (planar) {
          r = pixels[i];
          g = pixels[count + i];
          b = pixels[count * 2 + i];
        } else {
          r = pixels[i * 3];
          g = pixels[i * 3 + 1];
          b = pixels[i * 3 + 2];
        }
        if (ybr) {
          ybrToRgb(r, g, b, data, o);
        } else {
          data[o] = r; data[o + 1] = g; data[o + 2] = b;
        }
        data[o + 3] = 255;
      }
      if (lut.flip) {
        for (o = 0; o < data.length; o += 4) {
          data[o] = 255 - data[o];
          data[o + 1] = 255 - data[o + 1];
          data[o + 2] = 255 - data[o + 2];
        }
      }
      return;
    }

    if (image.photometric === 'PALETTE COLOR' && image.palette) {
      var palette = image.palette;
      var last = palette.entries - 1;
      for (i = 0, o = 0; i < count; i++, o += 4) {
        var index = pixels[i] - palette.firstMapped;
        if (index < 0) index = 0; else if (index > last) index = last;
        data[o] = palette.red[index];
        data[o + 1] = palette.green[index];
        data[o + 2] = palette.blue[index];
        data[o + 3] = 255;
      }
      return;
    }

    if (lut.table) {
      var table = lut.table;
      var offset = lut.offset;
      for (i = 0, o = 0; i < count; i++, o += 4) {
        var gray = table[pixels[i] + offset];
        data[o] = gray; data[o + 1] = gray; data[o + 2] = gray; data[o + 3] = 255;
      }
    } else {
      for (i = 0, o = 0; i < count; i++, o += 4) {
        var computed = lut.compute(pixels[i]);
        data[o] = computed; data[o + 1] = computed; data[o + 2] = computed; data[o + 3] = 255;
      }
    }
  };
})(window);
