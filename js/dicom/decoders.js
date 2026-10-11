/*
 * Extraccion y descompresion de pixel data.
 *
 * Transfer syntax soportados de forma nativa:
 *   1.2.840.10008.1.2        Implicit VR LE      (sin comprimir)
 *   1.2.840.10008.1.2.1      Explicit VR LE      (sin comprimir)
 *   1.2.840.10008.1.2.1.99   Deflated            (ya inflado por el parser)
 *   1.2.840.10008.1.2.2      Explicit VR BE      (sin comprimir, se swapea)
 *   1.2.840.10008.1.2.5      RLE Lossless        (decodificado aqui)
 *   1.2.840.10008.1.2.4.50   JPEG Baseline       (via el decoder del navegador)
 *   1.2.840.10008.1.2.4.51   JPEG Extended       (via el decoder del navegador)
 *
 * El resto de la familia JPEG (lossless, JPEG-LS, JPEG 2000, HTJ2K) necesita
 * un codec externo. Se pueden enchufar con:
 *
 *   DCM.decoders.register('1.2.840.10008.1.2.4.90', async (bytes, info) => {
 *     //  devolver { bytes: Uint8Array }  con los pixeles ya descomprimidos,
 *     //  en el mismo layout que tendrian sin comprimir
 *   });
 */
(function (global) {
  'use strict';

  var DCM = global.DCM = global.DCM || {};
  var TS = DCM.TS;

  var NATIVE = {};
  NATIVE[TS.IMPLICIT_LE] = 1;
  NATIVE[TS.EXPLICIT_LE] = 1;
  NATIVE[TS.DEFLATED_LE] = 1;
  NATIVE[TS.EXPLICIT_BE] = 1;

  var SYNTAX_NAMES = {
    '1.2.840.10008.1.2': 'Implicit VR Little Endian',
    '1.2.840.10008.1.2.1': 'Explicit VR Little Endian',
    '1.2.840.10008.1.2.1.99': 'Deflated Explicit VR Little Endian',
    '1.2.840.10008.1.2.2': 'Explicit VR Big Endian',
    '1.2.840.10008.1.2.4.50': 'JPEG Baseline (proceso 1)',
    '1.2.840.10008.1.2.4.51': 'JPEG Extended (proceso 2 y 4)',
    '1.2.840.10008.1.2.4.57': 'JPEG Lossless (proceso 14)',
    '1.2.840.10008.1.2.4.70': 'JPEG Lossless, prediccion 1 (proceso 14 SV1)',
    '1.2.840.10008.1.2.4.80': 'JPEG-LS sin perdida',
    '1.2.840.10008.1.2.4.81': 'JPEG-LS casi sin perdida',
    '1.2.840.10008.1.2.4.90': 'JPEG 2000 sin perdida',
    '1.2.840.10008.1.2.4.91': 'JPEG 2000',
    '1.2.840.10008.1.2.4.201': 'HTJ2K sin perdida (RPCL)',
    '1.2.840.10008.1.2.4.202': 'HTJ2K sin perdida',
    '1.2.840.10008.1.2.4.203': 'HTJ2K',
    '1.2.840.10008.1.2.5': 'RLE Lossless'
  };

  var registry = Object.create(null);

  // ------------------------------------------------------------------ RLE

  /**
   * RLE Lossless (PS3.5 Annex G). El header son 64 bytes: numero de segmentos
   * y sus offsets. Cada segmento es un plano de bytes, del mas significativo
   * al menos significativo dentro de cada muestra.
   */
  function decodeRLE(bytes, info) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var segmentCount = view.getUint32(0, true);
    if (segmentCount < 1 || segmentCount > 15) {
      throw new Error('Cabecera RLE invalida: ' + segmentCount + ' segmentos.');
    }

    var offsets = [];
    for (var s = 0; s < segmentCount; s++) offsets.push(view.getUint32(4 + s * 4, true));

    var bytesPerSample = info.bitsAllocated / 8;
    var stride = info.samplesPerPixel * bytesPerSample;
    var out = new Uint8Array(info.rows * info.columns * stride);

    for (var seg = 0; seg < segmentCount; seg++) {
      var start = offsets[seg];
      var end = (seg + 1 < segmentCount && offsets[seg + 1] > 0)
        ? offsets[seg + 1]
        : bytes.byteLength;
      if (start <= 0 || start >= bytes.byteLength) continue;

      var sample = Math.floor(seg / bytesPerSample);
      // El segmento 0 de cada muestra es el byte mas significativo; la salida
      // se escribe en little endian.
      var byteInSample = bytesPerSample - 1 - (seg % bytesPerSample);
      var o = sample * bytesPerSample + byteInSample;

      var p = start;
      while (p < end && o < out.length) {
        var control = view.getInt8(p);
        p++;
        if (control >= 0) {
          // Literal: control + 1 bytes a copiar.
          var literal = control + 1;
          for (var i = 0; i < literal && p < end && o < out.length; i++) {
            out[o] = bytes[p++];
            o += stride;
          }
        } else if (control !== -128) {
          // Repeticion: -control + 1 copias del byte siguiente.
          var repeat = -control + 1;
          var value = bytes[p++];
          for (var j = 0; j < repeat && o < out.length; j++) {
            out[o] = value;
            o += stride;
          }
        }
        // control === -128 se ignora por especificacion.
      }
    }

    // Tras decodificar, las muestras quedan entrelazadas.
    return { bytes: out, planarConfiguration: 0 };
  }

  // ------------------------------------------------------- JPEG del navegador

  /**
   * Decodifica JPEG baseline/extended usando el decoder nativo del navegador.
   * Importante: el resultado es RGBA de 8 bits, asi que se pierde la
   * profundidad original. Solo es aceptable para imagenes ya lossy de 8 bits
   * (fotografia clinica, captura secundaria, ultrasonido). Para TC no se
   * deberia usar: se marca `approximate` para que la UI lo avise.
   */
  async function decodeJPEGViaBrowser(bytes, info) {
    var blob = new Blob([bytes.slice()], { type: 'image/jpeg' });
    var bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch (err) {
      throw new Error('El navegador no pudo decodificar este JPEG: ' + err.message);
    }

    var canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    var rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    var pixelCount = bitmap.width * bitmap.height;
    var out;
    if (info.samplesPerPixel === 3) {
      out = new Uint8Array(pixelCount * 3);
      for (var i = 0, o = 0; i < pixelCount; i++) {
        out[o++] = rgba[i * 4];
        out[o++] = rgba[i * 4 + 1];
        out[o++] = rgba[i * 4 + 2];
      }
    } else {
      out = new Uint8Array(pixelCount);
      for (var k = 0; k < pixelCount; k++) out[k] = rgba[k * 4];
    }

    return {
      bytes: out,
      planarConfiguration: 0,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      pixelRepresentation: 0,
      photometricInterpretation: info.samplesPerPixel === 3 ? 'RGB' : 'MONOCHROME2',
      approximate: true,
      approximateReason: 'JPEG decodificado por el navegador a 8 bits por muestra; ' +
        'los valores no son fieles al original si la imagen tenia mas profundidad.'
    };
  }

  registry[TS.RLE] = decodeRLE;
  registry['1.2.840.10008.1.2.4.50'] = decodeJPEGViaBrowser;
  registry['1.2.840.10008.1.2.4.51'] = decodeJPEGViaBrowser;

  // ------------------------------------------------------------------ API

  /** Ensambla los bytes comprimidos de un frame a partir de los fragmentos. */
  function frameFragments(element, buffer, frameIndex, frameCount) {
    var fragments = element.fragments || [];
    if (!fragments.length) throw new Error('Pixel data encapsulado sin fragmentos.');

    var groups;
    if (fragments.length === frameCount) {
      // Caso habitual: un fragmento por frame.
      groups = [fragments[frameIndex]];
    } else if (frameCount === 1) {
      groups = fragments;
    } else {
      // Reparto uniforme como ultimo recurso.
      var perFrame = Math.max(1, Math.floor(fragments.length / frameCount));
      groups = fragments.slice(frameIndex * perFrame, (frameIndex + 1) * perFrame);
    }
    if (!groups.length || !groups[0]) {
      throw new Error('No hay fragmentos para el frame ' + frameIndex + '.');
    }

    var total = groups.reduce(function (sum, f) { return sum + f.length; }, 0);
    var out = new Uint8Array(total);
    var o = 0;
    for (var i = 0; i < groups.length; i++) {
      out.set(new Uint8Array(buffer, groups[i].offset, groups[i].length), o);
      o += groups[i].length;
    }
    return out;
  }

  DCM.decoders = {
    names: SYNTAX_NAMES,

    /** Registra o reemplaza el decoder de un transfer syntax. */
    register: function (transferSyntaxUID, fn) {
      registry[transferSyntaxUID] = fn;
    },

    /** true si el transfer syntax se puede leer sin descomprimir. */
    isNative: function (transferSyntaxUID) {
      return !!NATIVE[transferSyntaxUID];
    },

    /** true si hay forma de obtener pixeles para ese transfer syntax. */
    isSupported: function (transferSyntaxUID) {
      return !!NATIVE[transferSyntaxUID] || !!registry[transferSyntaxUID];
    },

    name: function (transferSyntaxUID) {
      return SYNTAX_NAMES[transferSyntaxUID] || transferSyntaxUID;
    },

    /**
     * Devuelve los bytes de pixel de un frame, ya descomprimidos.
     * `info` debe traer rows, columns, samplesPerPixel, bitsAllocated,
     * frameCount y photometricInterpretation.
     *
     * Devuelve { bytes, ...overrides } donde los overrides pueden corregir
     * los descriptores cuando el decoder cambia el formato.
     */
    getFrameBytes: async function (parsed, info, frameIndex) {
      var element = parsed.dataset.elements['7FE00010'];
      if (!element) throw new Error('El fichero no contiene datos de pixel (7FE0,0010).');

      var buffer = parsed.dataset.buffer;
      var ts = parsed.transferSyntax;

      if (!element.encapsulated) {
        if (!NATIVE[ts]) {
          throw new Error('Transfer syntax "' + DCM.decoders.name(ts) +
            '" declarado como comprimido pero el pixel data no esta encapsulado.');
        }
        var bytesPerSample = Math.ceil(info.bitsAllocated / 8);
        var frameSize = info.rows * info.columns * info.samplesPerPixel * bytesPerSample;
        if (info.bitsAllocated === 1) {
          frameSize = Math.ceil(info.rows * info.columns * info.samplesPerPixel / 8);
        }
        var start = element.offset + frameIndex * frameSize;
        var available = Math.min(frameSize, element.offset + element.length - start);
        if (available <= 0) {
          throw new Error('Frame ' + frameIndex + ' fuera de los datos de pixel.');
        }
        var raw = new Uint8Array(buffer, start, available);
        if (ts === TS.EXPLICIT_BE && bytesPerSample === 2) {
          raw = swap16(raw);
        }
        return { bytes: raw };
      }

      var decoder = registry[ts];
      if (!decoder) {
        throw new Error('Transfer syntax no soportado: ' + DCM.decoders.name(ts) +
          ' (' + ts + '). Hace falta registrar un codec; ver decoders.js.');
      }
      var compressed = frameFragments(element, buffer, frameIndex, info.frameCount);
      return await decoder(compressed, info);
    }
  };

  function swap16(src) {
    var out = new Uint8Array(src.length);
    for (var i = 0; i + 1 < src.length; i += 2) {
      out[i] = src[i + 1];
      out[i + 1] = src[i];
    }
    return out;
  }
})(window);
