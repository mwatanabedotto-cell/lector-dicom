/*
 * Generador de un estudio TC sintetico, en DICOM real.
 *
 * Para que sirva: no hay forma de probar un lector DICOM sin DICOM. Este
 * modulo escribe ficheros Explicit VR Little Endian validos en memoria, con
 * geometria coherente (ImagePositionPatient/ImageOrientationPatient,
 * PixelSpacing, RescaleSlope/Intercept), y los mete por la misma via que un
 * fichero abierto a mano. Asi el parser, la reconstruccion MPR y las
 * mediciones se ejercitan de punta a punta.
 *
 * El fantoma imita un torax axial con valores Hounsfield plausibles:
 * aire -1000, pulmon -780, grasa -95, partes blandas 45, sangre con
 * contraste 230, hueso esponjoso 260 y cortical 900.
 *
 * No es un modulo de produccion: se puede quitar sin tocar el resto.
 */
(function (global) {
  'use strict';

  var DCM = global.DCM = global.DCM || {};

  var ROWS = 256;
  var COLUMNS = 256;
  var SLICES = 48;
  var PIXEL_SPACING = 1.6;   // mm
  var SLICE_SPACING = 3.0;   // mm
  var SLICE_THICKNESS = 3.0;

  // ------------------------------------------------------ Escritor DICOM

  var LONG_VR = { OB: 1, OW: 1, OF: 1, SQ: 1, UT: 1, UN: 1 };
  var textEncoder = new TextEncoder();

  function pad(bytes, padByte) {
    if (bytes.length % 2 === 0) return bytes;
    var out = new Uint8Array(bytes.length + 1);
    out.set(bytes);
    out[bytes.length] = padByte;
    return out;
  }

  /** Codifica el valor segun el VR y devuelve los bytes ya con padding par. */
  function encodeValue(vr, value) {
    if (vr === 'US') {
      var us = new Uint8Array(2);
      new DataView(us.buffer).setUint16(0, value, true);
      return us;
    }
    if (vr === 'UL') {
      var ul = new Uint8Array(4);
      new DataView(ul.buffer).setUint32(0, value, true);
      return ul;
    }
    if (vr === 'OW') return value; // ya viene como Uint8Array
    if (vr === 'OB') return pad(value, 0);
    // El resto son cadenas. UI se rellena con nulo, los demas con espacio.
    var text = Array.isArray(value) ? value.join('\\') : String(value);
    return pad(textEncoder.encode(text), vr === 'UI' ? 0 : 0x20);
  }

  function elementBytes(tag, vr, value) {
    var group = parseInt(tag.slice(0, 4), 16);
    var element = parseInt(tag.slice(4), 16);
    var bytes = encodeValue(vr, value);
    var headerSize = LONG_VR[vr] ? 12 : 8;
    var out = new Uint8Array(headerSize + bytes.length);
    var view = new DataView(out.buffer);

    view.setUint16(0, group, true);
    view.setUint16(2, element, true);
    out[4] = vr.charCodeAt(0);
    out[5] = vr.charCodeAt(1);
    if (LONG_VR[vr]) {
      view.setUint16(6, 0, true);          // reservado
      view.setUint32(8, bytes.length, true);
    } else {
      view.setUint16(6, bytes.length, true);
    }
    out.set(bytes, headerSize);
    return out;
  }

  function concat(chunks) {
    var total = chunks.reduce(function (sum, c) { return sum + c.length; }, 0);
    var out = new Uint8Array(total);
    var offset = 0;
    chunks.forEach(function (c) { out.set(c, offset); offset += c.length; });
    return out;
  }

  /** Monta un fichero Part 10 completo a partir de una lista [tag, vr, valor]. */
  function buildFile(metaElements, dataElements) {
    var metaBody = concat(metaElements.map(function (e) {
      return elementBytes(e[0], e[1], e[2]);
    }));
    var groupLength = elementBytes('00020000', 'UL', metaBody.length);
    var dataBody = concat(dataElements
      .slice()
      .sort(function (a, b) { return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0); })
      .map(function (e) { return elementBytes(e[0], e[1], e[2]); }));

    var preamble = new Uint8Array(132);
    preamble[128] = 0x44; // D
    preamble[129] = 0x49; // I
    preamble[130] = 0x43; // C
    preamble[131] = 0x4D; // M

    return concat([preamble, groupLength, metaBody, dataBody]);
  }

  // --------------------------------------------------------- El fantoma

  // Generador congruencial: el fantoma debe ser identico en cada ejecucion
  // para que las mediciones sean comparables entre pruebas.
  function makeNoise(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function insideEllipse(dx, dy, a, b) {
    var nx = dx / a, ny = dy / b;
    return nx * nx + ny * ny;
  }

  /**
   * Valores Hounsfield del corte `k`. Devuelve un Int16Array de HU.
   * La anatomia varia con k para que el scroll y el MPR tengan sentido:
   * los pulmones se abren en el centro del volumen y se cierran arriba
   * y abajo, y hay un nodulo esferico en el pulmon izquierdo.
   */
  function sliceHU(k) {
    var out = new Int16Array(ROWS * COLUMNS);
    var noise = makeNoise(1000 + k * 7919);
    var cx = COLUMNS / 2;
    var cy = ROWS / 2;

    // Perfil craneocaudal: 0 en los extremos, 1 en el centro del volumen.
    var t = k / (SLICES - 1);
    var profile = Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.06) / 0.88)));
    profile = Math.max(0, profile);

    var bodyA = 86 + 10 * profile;
    var bodyB = 64 + 8 * profile;
    var lungA = 30 * profile;
    var lungB = 40 * profile;

    // Nodulo esferico de 8 mm de diametro en el pulmon izquierdo.
    var noduleSliceCenter = SLICES * 0.42;
    var noduleRadiusMM = 4;
    var dzMM = (k - noduleSliceCenter) * SLICE_SPACING;
    var noduleRadiusPx = dzMM * dzMM < noduleRadiusMM * noduleRadiusMM
      ? Math.sqrt(noduleRadiusMM * noduleRadiusMM - dzMM * dzMM) / PIXEL_SPACING
      : -1;

    for (var y = 0; y < ROWS; y++) {
      for (var x = 0; x < COLUMNS; x++) {
        var dx = x - cx;
        var dy = y - cy;
        var hu;

        var body = insideEllipse(dx, dy, bodyA, bodyB);
        if (body > 1) {
          hu = -1000 + noise() * 8;                       // aire ambiente
        } else if (body > 0.97) {
          hu = 55 + noise() * 20;                         // piel
        } else if (body > 0.88) {
          hu = -95 + noise() * 25;                        // grasa subcutanea
        } else {
          hu = 42 + noise() * 16;                         // musculo / mediastino

          // Pulmones
          var lungLeft = insideEllipse(dx + 40, dy - 4, lungA, lungB);
          var lungRight = insideEllipse(dx - 40, dy - 4, lungA, lungB);
          if (lungA > 4 && (lungLeft < 1 || lungRight < 1)) {
            hu = -780 + noise() * 60;
            // Arbol vascular disperso.
            if (noise() > 0.995) hu = 35 + noise() * 30;
          }

          // Mediastino y corazon en los cortes centrales.
          if (profile > 0.55 && insideEllipse(dx, dy - 14, 30 * profile, 24 * profile) < 1) {
            hu = 45 + noise() * 14;
          }

          // Cuerpo vertebral: cortical densa y esponjosa dentro.
          var vertebra = insideEllipse(dx, dy - 44, 17, 13);
          if (vertebra < 1) {
            hu = vertebra > 0.72 ? 900 + noise() * 120 : 255 + noise() * 70;
          }
          // Canal medular, por detras del cuerpo vertebral.
          if (insideEllipse(dx, dy - 58, 7, 6) < 1) hu = 32 + noise() * 12;

          // Aorta descendente y cava, por delante de la vertebra.
          if (insideEllipse(dx + 10, dy - 26, 7, 7) < 1) hu = 230 + noise() * 25;
          if (insideEllipse(dx - 13, dy - 24, 6, 6) < 1) hu = 120 + noise() * 20;

          // Esternon, en la linea media anterior.
          if (profile > 0.4 && insideEllipse(dx, dy + 54, 12, 5) < 1) {
            hu = 780 + noise() * 120;
          }

          // Nodulo pulmonar.
          if (noduleRadiusPx > 0 &&
              insideEllipse(dx + 46, dy - 10, noduleRadiusPx, noduleRadiusPx) < 1) {
            hu = 28 + noise() * 18;
          }
        }

        out[y * COLUMNS + x] = Math.max(-1024, Math.min(3071, Math.round(hu)));
      }
    }

    // Costillas: arcos laterales sobre la elipse del cuerpo, cada pocos
    // cortes. Se quedan en los sectores laterales para no cerrar un anillo.
    if (profile > 0.25 && k % 4 < 2) {
      for (var side = -1; side <= 1; side += 2) {
        for (var angle = -0.95; angle <= 0.95; angle += 0.012) {
          var rx = cx + side * bodyA * 0.91 * Math.cos(angle);
          var ry = cy + bodyB * 0.91 * Math.sin(angle);
          for (var w = -1; w <= 1; w++) {
            for (var h = -1; h <= 1; h++) {
              var px = Math.round(rx + w);
              var py = Math.round(ry + h);
              if (px >= 0 && py >= 0 && px < COLUMNS && py < ROWS) {
                out[py * COLUMNS + px] = 820;
              }
            }
          }
        }
      }
    }

    return out;
  }

  // ----------------------------------------------------------- Ensamblado

  function uid(root, parts) {
    return root + '.' + parts.join('.');
  }

  function pixelBytes(hu) {
    // Se guarda como unsigned de 12 bits utiles con intercepto -1024, que es
    // como lo escriben muchos equipos de TC. Ejercita el enmascarado por
    // BitsStored del parser.
    var out = new Uint8Array(hu.length * 2);
    var view = new DataView(out.buffer);
    for (var i = 0; i < hu.length; i++) {
      var stored = Math.max(0, Math.min(4095, hu[i] + 1024));
      view.setUint16(i * 2, stored, true);
    }
    return out;
  }

  DCM.phantom = {
    /** Construye los ficheros del estudio sintetico. Devuelve un array de File. */
    build: function (onProgress) {
      var stamp = Date.now();
      var root = '1.2.826.0.1.3680043.10.999';
      var studyUID = uid(root, [1, stamp]);
      var seriesUID = uid(root, [2, stamp]);
      var frameUID = uid(root, [3, stamp]);
      var files = [];

      for (var k = 0; k < SLICES; k++) {
        var hu = sliceHU(k);
        var zMM = (k - SLICES / 2) * SLICE_SPACING;

        var meta = [
          ['00020001', 'OB', new Uint8Array([0, 1])],
          ['00020002', 'UI', '1.2.840.10008.5.1.4.1.1.2'],
          ['00020003', 'UI', uid(root, [4, stamp, k])],
          ['00020010', 'UI', '1.2.840.10008.1.2.1'],
          ['00020012', 'UI', uid(root, [9, 1])],
          ['00020013', 'SH', 'LECTOR-DEV']
        ];

        var data = [
          ['00080005', 'CS', 'ISO_IR 100'],
          ['00080008', 'CS', 'DERIVED\\SECONDARY\\AXIAL'],
          ['00080016', 'UI', '1.2.840.10008.5.1.4.1.1.2'],
          ['00080018', 'UI', uid(root, [4, stamp, k])],
          ['00080020', 'DA', '20260301'],
          ['00080030', 'TM', '101500'],
          ['00080060', 'CS', 'CT'],
          ['00080070', 'LO', 'Fantoma sintetico'],
          ['00080080', 'LO', 'Banco de pruebas'],
          ['00081030', 'LO', 'TC torax fantoma'],
          ['0008103E', 'LO', 'Axial 3 mm reconstruccion blanda'],
          ['00081090', 'LO', 'lector-dicom phantom'],

          ['00100010', 'PN', 'PRUEBA^Fantoma'],
          ['00100020', 'LO', 'PHANTOM-0001'],
          ['00100030', 'DA', '19800115'],
          ['00100040', 'CS', 'O'],

          ['00180050', 'DS', String(SLICE_THICKNESS)],
          ['00180060', 'DS', '120'],
          ['00180088', 'DS', String(SLICE_SPACING)],
          ['00181151', 'IS', '180'],
          ['00181210', 'SH', 'B30f'],
          ['00185100', 'CS', 'HFS'],

          ['0020000D', 'UI', studyUID],
          ['0020000E', 'UI', seriesUID],
          ['00200010', 'SH', 'PH0001'],
          ['00200011', 'IS', '2'],
          ['00200013', 'IS', String(k + 1)],
          ['00200032', 'DS', [
            (-COLUMNS / 2 * PIXEL_SPACING).toFixed(3),
            (-ROWS / 2 * PIXEL_SPACING).toFixed(3),
            zMM.toFixed(3)
          ]],
          ['00200037', 'DS', ['1', '0', '0', '0', '1', '0']],
          ['00200052', 'UI', frameUID],
          ['00201041', 'DS', zMM.toFixed(3)],

          ['00280002', 'US', 1],
          ['00280004', 'CS', 'MONOCHROME2'],
          ['00280010', 'US', ROWS],
          ['00280011', 'US', COLUMNS],
          ['00280030', 'DS', [PIXEL_SPACING.toFixed(4), PIXEL_SPACING.toFixed(4)]],
          ['00280100', 'US', 16],
          ['00280101', 'US', 12],
          ['00280102', 'US', 11],
          ['00280103', 'US', 0],
          ['00281050', 'DS', '40'],
          ['00281051', 'DS', '400'],
          ['00281052', 'DS', '-1024'],
          ['00281053', 'DS', '1'],
          ['00281054', 'LO', 'HU'],

          ['7FE00010', 'OW', pixelBytes(hu)]
        ];

        var bytes = buildFile(meta, data);
        var name = 'CT.' + String(k + 1).padStart(4, '0') + '.dcm';
        files.push(new File([bytes], name, { type: 'application/dicom' }));
        if (onProgress) onProgress(k + 1, SLICES);
      }

      return files;
    },

    /** Genera el fantoma y lo carga en la aplicacion. */
    load: async function () {
      var files = DCM.phantom.build();
      await global.lector.loadFiles(files);
    }
  };
})(window);
