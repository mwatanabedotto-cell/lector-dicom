/*
 * Agrupacion en estudios/series y reconstruccion multiplanar (MPR).
 *
 * El volumen no se copia a un unico buffer 3D: se mantiene el array de
 * imagenes axiales ordenadas y las vistas coronal/sagital se muestrean de
 * ahi. Eso ahorra duplicar cientos de MB y hace que abrir una serie sea
 * inmediato.
 *
 * Limitacion asumida: la reconstruccion es ortogonal a los ejes de la
 * imagen (no hay MPR oblicuo). Es correcta cuando los cortes son paralelos
 * y equiespaciados, que es el caso de una TC o RM estandar.
 */
(function (global) {
  'use strict';

  var DCM = global.DCM = global.DCM || {};

  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }

  function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  function median(values) {
    if (!values.length) return undefined;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function norm(v) {
    return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  }

  function normalize(v) {
    var n = norm(v) || 1;
    return [v[0] / n, v[1] / n, v[2] / n];
  }

  DCM.vec = {
    cross: cross,
    dot: dot,
    norm: norm,
    normalize: normalize,
    add: function (a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; },
    sub: function (a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; },
    scale: function (v, s) { return [v[0] * s, v[1] * s, v[2] * s]; }
  };

  // ------------------------------------------------------- Arbol de estudios

  /**
   * Organiza una lista de imagenes en estudios -> series.
   * Las imagenes sin UID se agrupan por fichero para no perderlas.
   */
  DCM.buildStudies = function (entries) {
    var studies = [];
    var studyIndex = Object.create(null);

    entries.forEach(function (entry) {
      var image = entry.image;
      var studyKey = image.studyInstanceUID || ('sin-estudio:' + entry.fileName);
      var study = studyIndex[studyKey];
      if (!study) {
        study = {
          key: studyKey,
          studyInstanceUID: image.studyInstanceUID,
          patientName: entry.text.patientName,
          patientID: entry.text.patientID,
          patientSex: entry.text.patientSex,
          patientBirthDate: entry.text.patientBirthDate,
          studyDate: entry.text.studyDate,
          studyTime: entry.text.studyTime,
          studyDescription: entry.text.studyDescription,
          accessionNumber: entry.text.accessionNumber,
          institution: entry.text.institution,
          series: [],
          seriesIndex: Object.create(null)
        };
        studyIndex[studyKey] = study;
        studies.push(study);
      }

      var seriesKey = image.seriesInstanceUID || ('sin-serie:' + entry.fileName);
      var series = study.seriesIndex[seriesKey];
      if (!series) {
        series = {
          key: seriesKey,
          seriesInstanceUID: image.seriesInstanceUID,
          seriesNumber: entry.text.seriesNumber,
          seriesDescription: entry.text.seriesDescription,
          modality: image.modality,
          bodyPart: entry.text.bodyPart,
          protocol: entry.text.protocol,
          kernel: entry.text.kernel,
          study: study,
          entries: [],
          volume: null,
          volumeChecked: false
        };
        study.seriesIndex[seriesKey] = series;
        study.series.push(series);
      }
      series.entries.push(entry);
      entry.series = series;
    });

    studies.forEach(function (study) {
      delete study.seriesIndex;
      study.series.forEach(function (series) {
        sortSeries(series);
        series.count = series.entries.length;
      });
      study.series.sort(function (a, b) {
        var na = parseInt(a.seriesNumber, 10);
        var nb = parseInt(b.seriesNumber, 10);
        if (isFinite(na) && isFinite(nb) && na !== nb) return na - nb;
        return String(a.seriesDescription).localeCompare(String(b.seriesDescription));
      });
    });

    return studies;
  };

  /**
   * Ordena los cortes de una serie a lo largo de la normal del plano.
   * Si no hay geometria usable, cae a InstanceNumber y luego al nombre.
   */
  function sortSeries(series) {
    var reference = series.entries[0].image;
    var normal = null;
    if (reference.orientation && reference.orientation.length === 6) {
      normal = cross(reference.orientation.slice(0, 3), reference.orientation.slice(3, 6));
    }

    var usePosition = !!normal && series.entries.every(function (e) {
      return e.image.position && e.image.position.length === 3;
    });

    series.entries.forEach(function (entry) {
      entry.sortKey = usePosition
        ? dot(entry.image.position, normal)
        : (isFinite(entry.image.instanceNumber) ? entry.image.instanceNumber : 0);
    });

    series.sortedByPosition = usePosition;
    series.normal = normal;
    series.entries.sort(function (a, b) {
      if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
      var ia = isFinite(a.image.instanceNumber) ? a.image.instanceNumber : 0;
      var ib = isFinite(b.image.instanceNumber) ? b.image.instanceNumber : 0;
      if (ia !== ib) return ia - ib;
      return String(a.fileName).localeCompare(String(b.fileName), undefined, { numeric: true });
    });
  }

  // --------------------------------------------------------------- Volumen

  /**
   * Intenta construir un volumen reconstruible a partir de una serie.
   * Devuelve null con `series.volumeReason` explicando por que no se puede.
   */
  DCM.buildVolume = function (series) {
    if (series.volumeChecked) return series.volume;
    series.volumeChecked = true;
    series.volume = null;

    var images = series.entries.map(function (e) { return e.image; });
    if (images.length < 3) {
      series.volumeReason = 'La serie tiene menos de 3 cortes.';
      return null;
    }

    var first = images[0];
    if (first.samplesPerPixel !== 1) {
      series.volumeReason = 'La reconstruccion solo se aplica a imagenes en escala de grises.';
      return null;
    }

    var sameGrid = images.every(function (image) {
      return image.rows === first.rows && image.columns === first.columns &&
             image.pixels.constructor === first.pixels.constructor;
    });
    if (!sameGrid) {
      series.volumeReason = 'Los cortes no comparten matriz ni formato de pixel.';
      return null;
    }

    if (!series.sortedByPosition) {
      series.volumeReason = 'Los cortes no traen ImagePositionPatient/ImageOrientationPatient; ' +
        'no se puede situar el volumen en el espacio.';
      return null;
    }

    // Espaciado entre cortes a partir de las posiciones reales.
    var gaps = [];
    for (var i = 1; i < series.entries.length; i++) {
      gaps.push(series.entries[i].sortKey - series.entries[i - 1].sortKey);
    }
    var spacing = median(gaps.filter(function (g) { return g > 0; }));
    if (!spacing || !isFinite(spacing)) {
      spacing = first.spacingBetweenSlices || first.sliceThickness || 1;
    }

    var maxGap = Math.max.apply(null, gaps);
    var minGap = Math.min.apply(null, gaps);
    var irregular = (maxGap - minGap) > spacing * 0.25;
    var duplicates = gaps.some(function (g) { return g === 0; });

    // Homogeneidad de la transformacion de modalidad: si difiere entre cortes,
    // las vistas reconstruidas se normalizan a unidades de modalidad.
    var uniformRescale = images.every(function (image) {
      return image.slope === first.slope && image.intercept === first.intercept;
    });

    // Ejes del volumen en coordenadas de paciente (LPS). Se ortonormalizan
    // porque algunos equipos escriben ImageOrientationPatient con vectores
    // que no son exactamente perpendiculares.
    var axisI = normalize(first.orientation.slice(0, 3));
    var rawJ = first.orientation.slice(3, 6);
    var axisJ = normalize([
      rawJ[0] - axisI[0] * dot(rawJ, axisI),
      rawJ[1] - axisI[1] * dot(rawJ, axisI),
      rawJ[2] - axisI[2] * dot(rawJ, axisI)
    ]);
    var axisK = normalize(cross(axisI, axisJ));

    // Valor de relleno para lo que cae fuera del volumen: el minimo observado,
    // que en TC es aire.
    var probes = [images[0], images[images.length >> 1], images[images.length - 1]];
    var background = Math.min.apply(null, probes.map(function (im) { return im.minStored; }));

    var volume = {
      series: series,
      images: images,
      depth: images.length,
      rows: first.rows,
      columns: first.columns,
      colSpacing: first.colSpacing,
      rowSpacing: first.rowSpacing,
      sliceSpacing: Math.abs(spacing),
      slope: uniformRescale ? first.slope : 1,
      intercept: uniformRescale ? first.intercept : 0,
      uniformRescale: uniformRescale,
      unit: first.unit,
      modality: first.modality,
      irregular: irregular,
      duplicates: duplicates,
      // Orden de apilado: `flipZ` indica si el indice creciente va hacia los
      // pies del paciente, en cuyo caso las vistas coronal/sagital se dibujan
      // invertidas para que la cabeza quede arriba.
      flipZ: series.normal ? series.normal[2] < 0 : false,
      fileWindowWidth: first.fileWindowWidth,
      fileWindowCenter: first.fileWindowCenter,

      // Marco del volumen en coordenadas de paciente. Con esto se pasa de
      // indices de voxel a milimetros y al reves, que es lo que permite
      // reconstruir planos arbitrarios.
      origin: first.position.slice(0, 3),
      axisI: axisI,
      axisJ: axisJ,
      axisK: axisK,
      spacingI: first.colSpacing,
      spacingJ: first.rowSpacing,
      spacingK: Math.abs(spacing),
      sampleSpacing: Math.min(first.colSpacing, first.rowSpacing, Math.abs(spacing)),
      backgroundStored: background,

      _cache: Object.create(null)
    };

    series.volume = volume;
    series.volumeReason = null;
    return volume;
  };

  // ------------------------------------------------- Coordenadas de paciente

  /** Indices de voxel (continuos) -> milimetros de paciente. */
  DCM.toPatient = function (volume, i, j, k) {
    var a = volume.axisI, b = volume.axisJ, c = volume.axisK;
    var si = i * volume.spacingI, sj = j * volume.spacingJ, sk = k * volume.spacingK;
    return [
      volume.origin[0] + a[0] * si + b[0] * sj + c[0] * sk,
      volume.origin[1] + a[1] * si + b[1] * sj + c[1] * sk,
      volume.origin[2] + a[2] * si + b[2] * sj + c[2] * sk
    ];
  };

  /** Milimetros de paciente -> indices de voxel (continuos). */
  DCM.toVoxel = function (volume, point) {
    var dx = point[0] - volume.origin[0];
    var dy = point[1] - volume.origin[1];
    var dz = point[2] - volume.origin[2];
    var a = volume.axisI, b = volume.axisJ, c = volume.axisK;
    return {
      i: (dx * a[0] + dy * a[1] + dz * a[2]) / volume.spacingI,
      j: (dx * b[0] + dy * b[1] + dz * b[2]) / volume.spacingJ,
      k: (dx * c[0] + dy * c[1] + dz * c[2]) / volume.spacingK
    };
  };

  /**
   * Direccion en milimetros -> incremento en indices de voxel.
   * Como los ejes son ortonormales basta proyectar y dividir por el espaciado;
   * esto es lo que permite recorrer un plano oblicuo con tres sumas por pixel
   * en vez de una transformacion completa.
   */
  function directionToVoxel(volume, v) {
    var a = volume.axisI, b = volume.axisJ, c = volume.axisK;
    return {
      i: (v[0] * a[0] + v[1] * a[1] + v[2] * a[2]) / volume.spacingI,
      j: (v[0] * b[0] + v[1] * b[1] + v[2] * b[2]) / volume.spacingJ,
      k: (v[0] * c[0] + v[1] * c[1] + v[2] * c[2]) / volume.spacingK
    };
  }
  DCM.directionToVoxel = directionToVoxel;

  /** Extension del volumen proyectada sobre una direccion, en milimetros. */
  DCM.extentAlong = function (volume, direction) {
    var min = Infinity, max = -Infinity;
    for (var corner = 0; corner < 8; corner++) {
      var p = DCM.toPatient(volume,
        (corner & 1) ? volume.columns - 1 : 0,
        (corner & 2) ? volume.rows - 1 : 0,
        (corner & 4) ? volume.depth - 1 : 0);
      var d = dot(p, direction);
      if (d < min) min = d;
      if (d > max) max = d;
    }
    return { min: min, max: max, length: max - min };
  };

  // ------------------------------------------------------ Muestreo oblicuo

  /**
   * Interpolacion trilineal en el volumen. Fuera del volumen devuelve el
   * valor de fondo; en el borde extrapola con el voxel mas cercano.
   */
  function sampleTrilinear(volume, i, j, k) {
    var columns = volume.columns, rows = volume.rows, depth = volume.depth;
    if (i < -0.5 || j < -0.5 || k < -0.5 ||
        i > columns - 0.5 || j > rows - 0.5 || k > depth - 0.5) {
      return volume.backgroundStored;
    }

    var i0 = Math.floor(i), j0 = Math.floor(j), k0 = Math.floor(k);
    var fi = i - i0, fj = j - j0, fk = k - k0;
    if (i0 < 0) { i0 = 0; fi = 0; }
    if (j0 < 0) { j0 = 0; fj = 0; }
    if (k0 < 0) { k0 = 0; fk = 0; }
    var i1 = i0 + 1 < columns ? i0 + 1 : i0;
    var j1 = j0 + 1 < rows ? j0 + 1 : j0;
    var k1 = k0 + 1 < depth ? k0 + 1 : k0;

    var near = volume.images[k0].pixels;
    var far = volume.images[k1].pixels;
    var rowA = j0 * columns, rowB = j1 * columns;

    var c000 = near[rowA + i0], c100 = near[rowA + i1];
    var c010 = near[rowB + i0], c110 = near[rowB + i1];
    var c001 = far[rowA + i0], c101 = far[rowA + i1];
    var c011 = far[rowB + i0], c111 = far[rowB + i1];

    var w0 = 1 - fi, w1 = fi;
    var a00 = c000 * w0 + c100 * w1;
    var a10 = c010 * w0 + c110 * w1;
    var a01 = c001 * w0 + c101 * w1;
    var a11 = c011 * w0 + c111 * w1;
    var b0 = a00 * (1 - fj) + a10 * fj;
    var b1 = a01 * (1 - fj) + a11 * fj;
    return b0 * (1 - fk) + b1 * fk;
  }

  /** Vecino mas proximo: conserva los valores originales sin mezclar. */
  function sampleNearest(volume, i, j, k) {
    var ri = Math.round(i), rj = Math.round(j), rk = Math.round(k);
    if (ri < 0 || rj < 0 || rk < 0 ||
        ri >= volume.columns || rj >= volume.rows || rk >= volume.depth) {
      return volume.backgroundStored;
    }
    return volume.images[rk].pixels[rj * volume.columns + ri];
  }

  /**
   * Reconstruye un plano arbitrario del volumen.
   *
   * spec = {
   *   center:   [x,y,z] en milimetros de paciente, queda en el centro exacto
   *   right:    vector unitario, direccion de columna creciente
   *   down:     vector unitario, direccion de fila creciente
   *   width, height:  tamano de salida en pixeles
   *   spacing:  milimetros por pixel de salida
   *   slab:     grosor en milimetros a proyectar (0 = plano simple)
   *   slabMode: 'max' (MIP), 'min' (MinIP) o 'mean'
   *   interpolate: false para vecino mas proximo
   * }
   */
  DCM.sampleOblique = function (volume, spec) {
    var vec = DCM.vec;
    var width = spec.width, height = spec.height;
    var spacing = spec.spacing;
    var normal = vec.normalize(vec.cross(spec.right, spec.down));
    var sample = spec.interpolate === false ? sampleNearest : sampleTrilinear;

    var stepX = directionToVoxel(volume, vec.scale(spec.right, spacing));
    var stepY = directionToVoxel(volume, vec.scale(spec.down, spacing));

    // Muestras del slab, centradas en el plano. El numero se fuerza a impar
    // para que una de ellas caiga justo sobre el plano: de lo contrario un
    // MIP podria quedar por debajo del corte simple que representa.
    var slabStep = volume.sampleSpacing;
    var slabCount = 1;
    if (spec.slab > slabStep) {
      slabCount = Math.min(129, Math.max(3, Math.round(spec.slab / slabStep) + 1));
      if (slabCount % 2 === 0) slabCount++;
    }
    var stepZ = directionToVoxel(volume, vec.scale(normal, slabStep));
    var slabMode = spec.slabMode || 'max';

    var startPatient = vec.add(spec.center, vec.add(
      vec.scale(spec.right, -spacing * (width - 1) / 2),
      vec.scale(spec.down, -spacing * (height - 1) / 2)
    ));
    if (slabCount > 1) {
      startPatient = vec.add(startPatient,
        vec.scale(normal, -slabStep * (slabCount - 1) / 2));
    }
    var start = DCM.toVoxel(volume, startPatient);

    var Type = volume.uniformRescale ? volume.images[0].pixels.constructor : Int16Array;
    var out = new Type(width * height);

    for (var y = 0; y < height; y++) {
      var ri = start.i + y * stepY.i;
      var rj = start.j + y * stepY.j;
      var rk = start.k + y * stepY.k;
      var row = y * width;

      for (var x = 0; x < width; x++) {
        var value;
        if (slabCount === 1) {
          value = sample(volume, ri, rj, rk);
        } else {
          var acc = slabMode === 'min' ? Infinity : (slabMode === 'max' ? -Infinity : 0);
          for (var s = 0; s < slabCount; s++) {
            var v = sample(volume,
              ri + s * stepZ.i, rj + s * stepZ.j, rk + s * stepZ.k);
            if (slabMode === 'max') { if (v > acc) acc = v; }
            else if (slabMode === 'min') { if (v < acc) acc = v; }
            else acc += v;
          }
          value = slabMode === 'mean' ? acc / slabCount : acc;
        }
        out[row + x] = Math.round(value);
        ri += stepX.i; rj += stepX.j; rk += stepX.k;
      }
    }

    return DCM.createImage({
      label: spec.label || '',
      pixels: out,
      rows: height,
      columns: width,
      rowSpacing: spacing,
      colSpacing: spacing,
      slope: volume.slope,
      intercept: volume.intercept,
      unit: volume.unit,
      modality: volume.modality,
      fileWindowWidth: volume.fileWindowWidth,
      fileWindowCenter: volume.fileWindowCenter
    });
  };

  function cacheKey(plane, index, extra) {
    return plane + ':' + index + ':' + (extra || 0);
  }

  function put(volume, key, image) {
    var cache = volume._cache;
    var keys = Object.keys(cache);
    // Cache pequena: las vistas reconstruidas se regeneran rapido y no
    // conviene retener decenas de megas.
    if (keys.length > 24) delete cache[keys[0]];
    cache[key] = image;
    return image;
  }

  /** Indice de fila/columna de salida -> indice de corte, con el flip aplicado. */
  function sliceForRow(volume, outputRow) {
    return volume.flipZ ? outputRow : volume.depth - 1 - outputRow;
  }
  DCM.sliceForRow = sliceForRow;

  /** Corte axial: es la imagen original, sin resamplear. */
  DCM.axialSlice = function (volume, index) {
    var clamped = Math.max(0, Math.min(volume.depth - 1, Math.round(index)));
    return volume.images[clamped];
  };

  function normalized(volume, image, value) {
    // Devuelve el stored value equivalente en el espacio del volumen.
    if (volume.uniformRescale) return value;
    return Math.round(value * image.slope + image.intercept);
  }

  /**
   * Corte coronal en la fila `row` de la matriz axial.
   * Ancho = columnas de la axial, alto = numero de cortes.
   */
  DCM.coronalSlice = function (volume, row) {
    var j = Math.max(0, Math.min(volume.rows - 1, Math.round(row)));
    var key = cacheKey('coronal', j);
    if (volume._cache[key]) return volume._cache[key];

    var width = volume.columns;
    var height = volume.depth;
    var Type = volume.uniformRescale ? volume.images[0].pixels.constructor : Int16Array;
    var out = new Type(width * height);

    for (var y = 0; y < height; y++) {
      var image = volume.images[sliceForRow(volume, y)];
      var src = j * volume.columns;
      var dst = y * width;
      if (volume.uniformRescale) {
        for (var x = 0; x < width; x++) out[dst + x] = image.pixels[src + x];
      } else {
        for (var xn = 0; xn < width; xn++) {
          out[dst + xn] = normalized(volume, image, image.pixels[src + xn]);
        }
      }
    }

    return put(volume, key, DCM.createImage({
      label: 'Coronal',
      pixels: out,
      rows: height,
      columns: width,
      rowSpacing: volume.sliceSpacing,
      colSpacing: volume.colSpacing,
      slope: volume.slope,
      intercept: volume.intercept,
      unit: volume.unit,
      modality: volume.modality,
      fileWindowWidth: volume.fileWindowWidth,
      fileWindowCenter: volume.fileWindowCenter
    }));
  };

  /**
   * Corte sagital en la columna `col` de la matriz axial.
   * Ancho = filas de la axial, alto = numero de cortes.
   */
  DCM.sagittalSlice = function (volume, col) {
    var i = Math.max(0, Math.min(volume.columns - 1, Math.round(col)));
    var key = cacheKey('sagittal', i);
    if (volume._cache[key]) return volume._cache[key];

    var width = volume.rows;
    var height = volume.depth;
    var Type = volume.uniformRescale ? volume.images[0].pixels.constructor : Int16Array;
    var out = new Type(width * height);

    for (var y = 0; y < height; y++) {
      var image = volume.images[sliceForRow(volume, y)];
      var dst = y * width;
      for (var x = 0; x < width; x++) {
        var v = image.pixels[x * volume.columns + i];
        out[dst + x] = volume.uniformRescale ? v : normalized(volume, image, v);
      }
    }

    return put(volume, key, DCM.createImage({
      label: 'Sagital',
      pixels: out,
      rows: height,
      columns: width,
      rowSpacing: volume.sliceSpacing,
      colSpacing: volume.rowSpacing,
      slope: volume.slope,
      intercept: volume.intercept,
      unit: volume.unit,
      modality: volume.modality,
      fileWindowWidth: volume.fileWindowWidth,
      fileWindowCenter: volume.fileWindowCenter
    }));
  };

  /**
   * MIP axial sobre un slab centrado en `index`.
   * `slabMM` es el grosor en milimetros; 0 devuelve el corte simple.
   */
  DCM.axialMIP = function (volume, index, slabMM) {
    var center = Math.max(0, Math.min(volume.depth - 1, Math.round(index)));
    var half = Math.max(0, Math.floor((slabMM / 2) / volume.sliceSpacing));
    if (half === 0) return DCM.axialSlice(volume, center);

    var from = Math.max(0, center - half);
    var to = Math.min(volume.depth - 1, center + half);
    var key = cacheKey('mip', center, to - from);
    if (volume._cache[key]) return volume._cache[key];

    var count = volume.rows * volume.columns;
    var Type = volume.uniformRescale ? volume.images[0].pixels.constructor : Int16Array;
    var out = new Type(count);
    var base = volume.images[from];
    for (var p = 0; p < count; p++) {
      out[p] = volume.uniformRescale ? base.pixels[p] : normalized(volume, base, base.pixels[p]);
    }

    for (var k = from + 1; k <= to; k++) {
      var image = volume.images[k];
      for (var q = 0; q < count; q++) {
        var v = volume.uniformRescale
          ? image.pixels[q]
          : normalized(volume, image, image.pixels[q]);
        if (v > out[q]) out[q] = v;
      }
    }

    return put(volume, key, DCM.createImage({
      label: 'MIP ' + Math.round((to - from + 1) * volume.sliceSpacing) + ' mm',
      pixels: out,
      rows: volume.rows,
      columns: volume.columns,
      rowSpacing: volume.rowSpacing,
      colSpacing: volume.colSpacing,
      slope: volume.slope,
      intercept: volume.intercept,
      unit: volume.unit,
      modality: volume.modality,
      fileWindowWidth: volume.fileWindowWidth,
      fileWindowCenter: volume.fileWindowCenter
    }));
  };
})(window);
