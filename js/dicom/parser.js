/*
 * Parser DICOM Part 10.
 *
 * Soporta:
 *   - Preambulo de 128 bytes + "DICM", y tambien ficheros sin preambulo.
 *   - Implicit VR Little Endian, Explicit VR Little Endian / Big Endian.
 *   - Deflated Explicit VR LE (se infla con DecompressionStream).
 *   - Secuencias (SQ) con longitud definida e indefinida, anidadas.
 *   - Pixel data nativo y encapsulado (fragmentos + Basic Offset Table).
 *
 * No decodifica pixeles: eso es tarea de decoders.js. Aqui solo se localizan
 * los elementos y se exponen accesores tipados.
 */
(function (global) {
  'use strict';

  var DCM = global.DCM = global.DCM || {};

  var TS = DCM.TS = {
    IMPLICIT_LE: '1.2.840.10008.1.2',
    EXPLICIT_LE: '1.2.840.10008.1.2.1',
    DEFLATED_LE: '1.2.840.10008.1.2.1.99',
    EXPLICIT_BE: '1.2.840.10008.1.2.2',
    RLE: '1.2.840.10008.1.2.5'
  };

  // VRs cuya longitud se codifica en 4 bytes (con 2 bytes reservados delante).
  var LONG_VR = { OB: 1, OD: 1, OF: 1, OL: 1, OV: 1, OW: 1, SQ: 1, UC: 1, UN: 1, UR: 1, UT: 1 };
  // VRs cuyo valor es texto.
  var TEXT_VR = {
    AE: 1, AS: 1, CS: 1, DA: 1, DS: 1, DT: 1, IS: 1, LO: 1, LT: 1,
    PN: 1, SH: 1, ST: 1, TM: 1, UC: 1, UI: 1, UR: 1, UT: 1
  };

  var UNDEFINED_LENGTH = 0xFFFFFFFF;
  var ITEM = 'FFFEE000';
  var ITEM_DELIM = 'FFFEE00D';
  var SEQ_DELIM = 'FFFEE0DD';
  var PIXEL_DATA = '7FE00010';

  var latin1 = new TextDecoder('iso-8859-1');
  var utf8 = new TextDecoder('utf-8');

  // ---------------------------------------------------------------- Dataset

  /**
   * Conjunto de elementos que comparten un ArrayBuffer.
   * Los valores no se copian: cada elemento guarda offset y longitud.
   */
  function Dataset(buffer, littleEndian, implicitVR) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.littleEndian = littleEndian !== false;
    this.implicitVR = !!implicitVR;
    this.elements = Object.create(null);
    this.charset = null;
  }

  Dataset.prototype.has = function (tag) {
    return this.elements[tag] !== undefined;
  };

  Dataset.prototype.element = function (tag) {
    return this.elements[tag];
  };

  /** Bytes crudos del valor, o null. */
  Dataset.prototype.raw = function (tag) {
    var el = this.elements[tag];
    if (!el || el.length <= 0) return null;
    return new Uint8Array(this.buffer, el.offset, el.length);
  };

  /** Texto del valor, sin padding de nulos/espacios. */
  Dataset.prototype.string = function (tag, fallback) {
    var el = this.elements[tag];
    if (!el || el.length <= 0) return fallback !== undefined ? fallback : '';
    var decoder = /ISO_IR 192|ISO 2022 IR 6\\ISO 2022 IR 87/.test(this.charset || '') ? utf8 : latin1;
    var text = decoder.decode(new Uint8Array(this.buffer, el.offset, el.length));
    return text.replace(/[\u0000\s]+$/, '');
  };

  /** Valor multiple separado por backslash. */
  Dataset.prototype.strings = function (tag) {
    var text = this.string(tag, null);
    if (text === null || text === '') return [];
    return text.split('\\').map(function (s) { return s.replace(/^\s+|\s+$/g, ''); });
  };

  /**
   * Primer valor numerico. Funciona tanto con VR de texto (DS/IS) como con
   * VR binarios (US/SS/UL/SL/FL/FD).
   */
  Dataset.prototype.number = function (tag, fallback) {
    var values = this.numbers(tag);
    if (!values.length || !isFinite(values[0])) {
      return fallback !== undefined ? fallback : undefined;
    }
    return values[0];
  };

  /** Todos los valores numericos del elemento. */
  Dataset.prototype.numbers = function (tag) {
    var el = this.elements[tag];
    if (!el || el.length <= 0) return [];
    var vr = el.vr;
    if (vr === 'xs') vr = this.number('00280103', 0) === 1 ? 'SS' : 'US';

    if (TEXT_VR[vr]) {
      return this.strings(tag)
        .map(function (s) { return parseFloat(s); })
        .filter(function (n) { return !isNaN(n); });
    }

    var le = this.littleEndian;
    var view = this.view;
    var out = [];
    var size = { US: 2, SS: 2, AT: 2, UL: 4, SL: 4, FL: 4, FD: 8, SV: 8, UV: 8 }[vr];
    if (!size) return [];
    for (var off = el.offset; off + size <= el.offset + el.length; off += size) {
      switch (vr) {
        case 'US': case 'AT': out.push(view.getUint16(off, le)); break;
        case 'SS': out.push(view.getInt16(off, le)); break;
        case 'UL': out.push(view.getUint32(off, le)); break;
        case 'SL': out.push(view.getInt32(off, le)); break;
        case 'FL': out.push(view.getFloat32(off, le)); break;
        case 'FD': out.push(view.getFloat64(off, le)); break;
        case 'SV': out.push(Number(view.getBigInt64(off, le))); break;
        case 'UV': out.push(Number(view.getBigUint64(off, le))); break;
      }
    }
    return out;
  };

  /** Items de una secuencia, como array de Dataset. Vacio si no es SQ. */
  Dataset.prototype.sequence = function (tag) {
    var el = this.elements[tag];
    return el && el.items ? el.items : [];
  };

  /** Primer item de una secuencia, o null. */
  Dataset.prototype.item = function (tag) {
    var items = this.sequence(tag);
    return items.length ? items[0] : null;
  };

  /**
   * Representacion plana para el panel de metadatos.
   * Los valores binarios largos se resumen en lugar de volcarse.
   */
  Dataset.prototype.toEntries = function (maxValueChars) {
    var limit = maxValueChars || 160;
    var self = this;
    var out = [];

    function walk(ds, depth) {
      var tags = Object.keys(ds.elements).sort();
      for (var i = 0; i < tags.length; i++) {
        var tag = tags[i];
        var el = ds.elements[tag];
        var entry = {
          tag: tag,
          vr: el.vr,
          name: DCM.tagName(tag),
          depth: depth,
          length: el.length,
          value: ''
        };
        if (el.items) {
          entry.value = el.items.length + ' item(s)';
          out.push(entry);
          for (var k = 0; k < el.items.length; k++) walk(el.items[k], depth + 1);
          continue;
        }
        if (tag === PIXEL_DATA) {
          entry.value = el.fragments
            ? el.fragments.length + ' fragmento(s) encapsulado(s)'
            : el.length + ' bytes';
        } else if (TEXT_VR[el.vr]) {
          entry.value = ds.string(tag);
        } else if (el.vr === 'SQ' || el.vr === 'OB' || el.vr === 'OW' ||
                   el.vr === 'UN' || el.vr === 'OF' || el.vr === 'OD') {
          entry.value = '<' + el.length + ' bytes>';
        } else {
          entry.value = ds.numbers(tag).join(', ');
        }
        if (entry.value.length > limit) entry.value = entry.value.slice(0, limit) + '...';
        out.push(entry);
      }
    }

    walk(self, 0);
    return out;
  };

  DCM.Dataset = Dataset;

  // ---------------------------------------------------------------- Lectura

  function readTag(view, pos, le) {
    return DCM.tagKey(view.getUint16(pos, le), view.getUint16(pos + 2, le));
  }

  function isValidVR(a, b) {
    return a >= 65 && a <= 90 && b >= 65 && b <= 90;
  }

  /**
   * Lee elementos en [start, end) dentro de ds y los guarda en `target`.
   * Devuelve la posicion donde se detuvo.
   */
  function readElements(ds, start, end, target) {
    var view = ds.view;
    var le = ds.littleEndian;
    var pos = start;

    while (pos + 8 <= end) {
      var tag = readTag(view, pos, le);

      // Los delimitadores de item/secuencia siempre llevan longitud de 4 bytes
      // y nunca VR explicito.
      if (tag === ITEM_DELIM || tag === SEQ_DELIM) {
        return pos + 8;
      }
      if (tag === ITEM) {
        // Un item suelto aqui indica que el llamador se equivoco de contexto.
        return pos;
      }

      pos += 4;
      var vr, length;

      if (ds.implicitVR) {
        length = view.getUint32(pos, le);
        pos += 4;
        var known = DCM.dictionary[tag];
        vr = known ? known.vr : (length === UNDEFINED_LENGTH ? 'SQ' : 'UN');
      } else {
        var c0 = view.getUint8(pos), c1 = view.getUint8(pos + 1);
        if (isValidVR(c0, c1)) {
          vr = String.fromCharCode(c0, c1);
          pos += 2;
          if (LONG_VR[vr]) {
            pos += 2; // reservado
            length = view.getUint32(pos, le);
            pos += 4;
          } else {
            length = view.getUint16(pos, le);
            pos += 2;
          }
        } else {
          // Fichero mal formado: elemento codificado como implicito dentro de
          // un dataset explicito. Se lee como implicito y se sigue.
          length = view.getUint32(pos, le);
          pos += 4;
          var alt = DCM.dictionary[tag];
          vr = alt ? alt.vr : (length === UNDEFINED_LENGTH ? 'SQ' : 'UN');
        }
      }

      // "xs" se deja tal cual: Dataset.numbers() lo resuelve a US o SS
      // consultando PixelRepresentation en el momento de leer el valor.
      var el = { tag: tag, vr: vr, offset: pos, length: length };

      if (length === UNDEFINED_LENGTH) {
        if (tag === PIXEL_DATA) {
          var frag = readFragments(ds, pos, end);
          el.fragments = frag.fragments;
          el.length = frag.next - pos;
          el.encapsulated = true;
          pos = frag.next;
        } else {
          var seq = readSequenceItems(ds, pos, end, true);
          el.vr = 'SQ';
          el.items = seq.items;
          el.length = seq.next - pos;
          pos = seq.next;
        }
      } else {
        if (length < 0 || pos + length > end) {
          // Longitud imposible: se recorta al limite disponible y se aborta
          // para no leer basura.
          el.length = Math.max(0, end - pos);
          target[tag] = el;
          return end;
        }
        if (vr === 'SQ') {
          el.items = readSequenceItems(ds, pos, pos + length, false).items;
        }
        pos += length;
      }

      target[tag] = el;

      if (tag === '00080005' && ds.charset === null) {
        ds.charset = ds.string('00080005', '');
      }
    }

    return pos;
  }

  /** Lee los items de una secuencia. */
  function readSequenceItems(ds, start, end, undefinedLength) {
    var view = ds.view;
    var le = ds.littleEndian;
    var pos = start;
    var items = [];

    while (pos + 8 <= end) {
      var tag = readTag(view, pos, le);
      var length = view.getUint32(pos + 4, le);
      pos += 8;

      if (tag === SEQ_DELIM) return { items: items, next: pos };
      if (tag !== ITEM) {
        // Estructura inesperada; se corta aqui.
        return { items: items, next: pos - 8 };
      }

      var item = new Dataset(ds.buffer, ds.littleEndian, ds.implicitVR);
      item.charset = ds.charset;
      items.push(item);

      if (length === UNDEFINED_LENGTH) {
        // readElements se detiene tras consumir el delimitador de item.
        pos = readElements(ds, pos, end, item.elements);
      } else {
        var itemEnd = Math.min(pos + length, end);
        readElements(ds, pos, itemEnd, item.elements);
        pos = itemEnd;
      }
    }

    return { items: items, next: pos };
  }

  /** Lee los fragmentos de pixel data encapsulado. */
  function readFragments(ds, start, end) {
    var view = ds.view;
    var le = ds.littleEndian;
    var pos = start;
    var fragments = [];
    var basicOffsetTable = null;
    var first = true;

    while (pos + 8 <= end) {
      var tag = readTag(view, pos, le);
      var length = view.getUint32(pos + 4, le);
      pos += 8;

      if (tag === SEQ_DELIM) break;
      if (tag !== ITEM) break;
      if (length === UNDEFINED_LENGTH || pos + length > end) break;

      if (first) {
        // El primer item es la Basic Offset Table (puede tener longitud 0).
        first = false;
        if (length > 0) {
          basicOffsetTable = [];
          for (var o = pos; o + 4 <= pos + length; o += 4) {
            basicOffsetTable.push(view.getUint32(o, le));
          }
        }
        pos += length;
        continue;
      }

      fragments.push({ offset: pos, length: length });
      pos += length;
    }

    return { fragments: fragments, basicOffsetTable: basicOffsetTable, next: pos };
  }

  // ---------------------------------------------------------------- API

  function findMagic(bytes) {
    // Caso normal: preambulo de 128 bytes y luego "DICM".
    if (bytes.length > 132 &&
        bytes[128] === 0x44 && bytes[129] === 0x49 &&
        bytes[130] === 0x43 && bytes[131] === 0x4D) {
      return 132;
    }
    // Algunos ficheros omiten el preambulo.
    if (bytes.length > 4 &&
        bytes[0] === 0x44 && bytes[1] === 0x49 &&
        bytes[2] === 0x43 && bytes[3] === 0x4D) {
      return 4;
    }
    return -1;
  }

  /** Comprobacion rapida sin parsear, para filtrar ficheros de una carpeta. */
  DCM.looksLikeDicom = function (buffer) {
    return findMagic(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 140))) !== -1;
  };

  async function inflateRaw(buffer, offset) {
    var slice = buffer.slice(offset);
    var formats = ['deflate-raw', 'deflate'];
    for (var i = 0; i < formats.length; i++) {
      try {
        var stream = new Blob([slice]).stream()
          .pipeThrough(new DecompressionStream(formats[i]));
        return await new Response(stream).arrayBuffer();
      } catch (err) {
        if (i === formats.length - 1) {
          throw new Error('No se pudo descomprimir el dataset deflated: ' + err.message);
        }
      }
    }
  }

  /**
   * Parsea un ArrayBuffer DICOM completo.
   * Devuelve { meta, dataset, transferSyntax, implicitVR, littleEndian }.
   */
  DCM.parse = async function (buffer) {
    var bytes = new Uint8Array(buffer);
    var magicEnd = findMagic(bytes);
    var meta = null;
    var transferSyntax = TS.IMPLICIT_LE;
    var datasetStart;

    if (magicEnd === -1) {
      // Sin cabecera Part 10: se asume Implicit VR LE desde el byte 0.
      // Es lo que producen algunos exportadores antiguos.
      datasetStart = 0;
    } else {
      meta = new Dataset(buffer, true, false);
      var metaEnd = readElements(meta, magicEnd, buffer.byteLength, meta.elements);
      // (0002,0000) da la longitud exacta del grupo meta; si falta, se usa
      // hasta donde el grupo 0002 dejo de aparecer.
      var groupLength = meta.number('00020000');
      if (groupLength !== undefined) {
        var lengthEl = meta.elements['00020000'];
        datasetStart = lengthEl.offset + lengthEl.length + groupLength;
      } else {
        datasetStart = metaEnd;
      }
      // El grupo meta puede haberse leido de mas; se recorta a los tags 0002.
      var metaTags = Object.keys(meta.elements);
      for (var i = 0; i < metaTags.length; i++) {
        if (metaTags[i].slice(0, 4) !== '0002') delete meta.elements[metaTags[i]];
      }
      transferSyntax = meta.string('00020010', TS.EXPLICIT_LE) || TS.EXPLICIT_LE;
    }

    if (datasetStart > buffer.byteLength) {
      throw new Error('Cabecera DICOM inconsistente: el dataset empieza fuera del fichero.');
    }

    var littleEndian = transferSyntax !== TS.EXPLICIT_BE;
    var implicitVR = transferSyntax === TS.IMPLICIT_LE;

    var dataBuffer = buffer;
    var dataOffset = datasetStart;
    if (transferSyntax === TS.DEFLATED_LE) {
      dataBuffer = await inflateRaw(buffer, datasetStart);
      dataOffset = 0;
    }

    var dataset = new Dataset(dataBuffer, littleEndian, implicitVR);
    readElements(dataset, dataOffset, dataBuffer.byteLength, dataset.elements);

    return {
      meta: meta,
      dataset: dataset,
      transferSyntax: transferSyntax,
      implicitVR: implicitVR,
      littleEndian: littleEndian
    };
  };
})(window);
