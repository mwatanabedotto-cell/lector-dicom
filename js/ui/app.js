/*
 * Aplicacion: carga de ficheros, arbol de series, paneles y sincronizacion.
 *
 * Todo ocurre en el navegador. Los ficheros se leen con la File API y nunca
 * salen del equipo.
 */
(function (global) {
  'use strict';

  var DCM = global.DCM;

  var state = {
    entries: [],
    studies: [],
    series: null,
    volume: null,
    // Posicion y orientacion de la reconstruccion. `center` esta en
    // milimetros de paciente y `frame` es el marco ortonormal de los tres
    // planos; asi el estado no depende de que las vistas sean ortogonales.
    center: null,
    frame: null,
    views: Object.create(null),
    index: 0,
    layout: '1x1',
    tool: 'wwwl',
    ww: 400,
    wc: 40,
    presetId: 'default',
    invert: false,
    smooth: true,
    slab: 20,
    annotations: Object.create(null),
    annotationMeta: Object.create(null),
    log: [],
    activeViewport: 0,
    cine: null
  };

  var viewports = [];
  var dom = {};

  function $(id) { return document.getElementById(id); }

  // --------------------------------------------------------------- Formato

  function personName(value) {
    if (!value) return '';
    // PN: apellidos^nombre^medio^prefijo^sufijo
    var parts = value.split('^');
    var family = (parts[0] || '').replace(/\s+/g, ' ').trim();
    var given = (parts[1] || '').replace(/\s+/g, ' ').trim();
    if (family && given) return given + ' ' + family;
    return (family || given || value).trim();
  }

  function dicomDate(value) {
    if (!value || value.length < 8) return value || '';
    return value.slice(6, 8) + '/' + value.slice(4, 6) + '/' + value.slice(0, 4);
  }

  function dicomTime(value) {
    if (!value || value.length < 4) return '';
    return value.slice(0, 2) + ':' + value.slice(2, 4) +
      (value.length >= 6 ? ':' + value.slice(4, 6) : '');
  }

  function num(value, decimals) {
    if (value === undefined || value === null || !isFinite(value)) return '';
    return Number(value).toFixed(decimals === undefined ? 2 : decimals).replace(/\.?0+$/, '');
  }

  function bytesLabel(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' kB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  // ----------------------------------------------------------- Estado / log

  function status(message) {
    dom.statusMessage.textContent = message;
  }

  function log(level, message, fileName) {
    state.log.push({ level: level, message: message, fileName: fileName || '' });
    renderLog();
  }

  function renderLog() {
    if (!state.log.length) {
      dom.logList.className = 'log-list muted';
      dom.logList.textContent = 'Sin avisos.';
      return;
    }
    dom.logList.className = 'log-list';
    dom.logList.innerHTML = '';
    state.log.slice(-200).forEach(function (item) {
      var div = document.createElement('div');
      div.className = 'log-item ' + item.level;
      div.textContent = item.message;
      if (item.fileName) {
        var span = document.createElement('span');
        span.className = 'li-file';
        span.textContent = item.fileName;
        div.appendChild(span);
      }
      dom.logList.appendChild(div);
    });
    dom.logList.scrollTop = dom.logList.scrollHeight;
  }

  function progress(done, total) {
    if (total <= 0) {
      dom.progressWrap.classList.add('hidden');
      return;
    }
    dom.progressWrap.classList.remove('hidden');
    dom.progressBar.style.width = Math.round((done / total) * 100) + '%';
  }

  // -------------------------------------------------------------- Carga

  var SKIP_NAMES = /^(dicomdir|lockfile|version|readme|index\.html?|\.ds_store|thumbs\.db)$/i;

  function shouldTry(file) {
    var name = (file.name || '').toLowerCase();
    if (SKIP_NAMES.test(name)) return false;
    if (/\.(zip|rar|7z|pdf|txt|xml|json|jpg|jpeg|png|gif|mp4|avi|exe|dll|css|js|html)$/.test(name)) {
      return false;
    }
    return file.size > 256;
  }

  async function readMagic(file) {
    try {
      var head = await file.slice(0, 140).arrayBuffer();
      return DCM.looksLikeDicom(head);
    } catch (err) {
      return false;
    }
  }

  function describe(dataset) {
    return {
      patientName: personName(dataset.string('00100010', '')),
      patientID: dataset.string('00100020', ''),
      patientSex: dataset.string('00100040', ''),
      patientBirthDate: dataset.string('00100030', ''),
      patientAge: dataset.string('00101010', ''),
      studyDate: dataset.string('00080020', ''),
      studyTime: dataset.string('00080030', ''),
      studyDescription: dataset.string('00081030', ''),
      accessionNumber: dataset.string('00080050', ''),
      institution: dataset.string('00080080', ''),
      seriesNumber: dataset.string('00200011', ''),
      seriesDescription: dataset.string('0008103E', ''),
      bodyPart: dataset.string('00180015', ''),
      protocol: dataset.string('00181030', ''),
      kernel: dataset.string('00181210', ''),
      kvp: dataset.string('00180060', ''),
      mA: dataset.string('00181151', ''),
      manufacturer: dataset.string('00080070', ''),
      model: dataset.string('00081090', ''),
      patientPosition: dataset.string('00185100', '')
    };
  }

  async function loadFiles(files) {
    var candidates = Array.prototype.slice.call(files).filter(shouldTry);
    if (!candidates.length) {
      status('No se encontraron ficheros utilizables.');
      return;
    }

    status('Explorando ' + candidates.length + ' ficheros...');
    var accepted = [];
    for (var i = 0; i < candidates.length; i++) {
      var file = candidates[i];
      var ok = await readMagic(file);
      if (!ok && !/\.(dcm|dicom|ima|img)$/i.test(file.name)) continue;
      accepted.push(file);
    }

    if (!accepted.length) {
      status('Ninguno de los ficheros tiene cabecera DICOM.');
      log('warn', 'Se revisaron ' + candidates.length +
        ' ficheros y ninguno parece DICOM (falta la marca "DICM").');
      return;
    }

    var entries = [];
    var failures = 0;
    var totalBytes = 0;

    for (var k = 0; k < accepted.length; k++) {
      var current = accepted[k];
      progress(k, accepted.length);
      status('Leyendo ' + (k + 1) + ' de ' + accepted.length + ': ' + current.name);

      try {
        var buffer = await current.arrayBuffer();
        var parsed = await DCM.parse(buffer);
        var text = describe(parsed.dataset);
        var frames = Math.max(1, parseInt(parsed.dataset.string('00280008', '1'), 10) || 1);

        for (var f = 0; f < frames; f++) {
          var image = await DCM.buildImage(parsed, f);
          entries.push({
            file: current,
            fileName: current.name,
            path: current.webkitRelativePath || current.name,
            image: image,
            text: text,
            frames: frames
          });
          totalBytes += image.pixels.byteLength;
        }
        if (parsed.transferSyntax && !DCM.decoders.isNative(parsed.transferSyntax)) {
          noteOnce('ts:' + parsed.transferSyntax, 'warn',
            'Serie comprimida con ' + DCM.decoders.name(parsed.transferSyntax) + '.');
        }
      } catch (err) {
        failures++;
        log('error', err.message, current.name);
      }

      // Se cede el hilo para que la barra de progreso avance de verdad.
      if (k % 4 === 3) await new Promise(function (r) { setTimeout(r, 0); });
    }

    progress(0, 0);

    if (!entries.length) {
      status('No se pudo leer ninguna imagen. Mira la pestana Avisos.');
      return;
    }

    state.entries = state.entries.concat(entries);
    state.studies = DCM.buildStudies(state.entries);
    state.annotations = Object.create(null);
    state.annotationMeta = Object.create(null);

    renderStudies();
    var firstSeries = state.studies[0] && state.studies[0].series[0];
    if (firstSeries) selectSeries(firstSeries);

    dom.dropzone.classList.add('hidden');
    status(entries.length + ' imagenes cargadas (' + bytesLabel(totalBytes) + ' de pixeles)' +
      (failures ? ', ' + failures + ' con error' : '') + '.');
  }

  var noted = Object.create(null);
  function noteOnce(key, level, message) {
    if (noted[key]) return;
    noted[key] = true;
    log(level, message);
  }

  // ------------------------------------------------------- Arbol de series

  function renderStudies() {
    dom.seriesList.innerHTML = '';
    var totalSeries = 0;

    state.studies.forEach(function (study) {
      totalSeries += study.series.length;
      var label = document.createElement('div');
      label.className = 'study-label';
      label.textContent = [
        dicomDate(study.studyDate),
        study.studyDescription || 'Estudio sin descripcion'
      ].filter(Boolean).join(' · ');
      dom.seriesList.appendChild(label);

      study.series.forEach(function (series) {
        dom.seriesList.appendChild(seriesItem(series));
      });
    });

    dom.seriesCount.textContent = totalSeries + ' serie' + (totalSeries === 1 ? '' : 's');
    renderPatientCard(state.studies[0]);
  }

  function seriesItem(series) {
    var item = document.createElement('div');
    item.className = 'series-item';
    item.dataset.key = series.key;

    var thumb = document.createElement('canvas');
    thumb.width = 56;
    thumb.height = 56;
    item.appendChild(thumb);

    var info = document.createElement('div');
    var title = document.createElement('div');
    title.className = 'si-title';
    title.textContent = (series.seriesNumber ? '#' + series.seriesNumber + ' ' : '') +
      (series.seriesDescription || series.protocol || 'Serie');
    title.title = title.textContent;
    info.appendChild(title);

    var meta = document.createElement('div');
    meta.className = 'si-meta';
    var first = series.entries[0].image;
    meta.textContent = [
      series.modality,
      series.count + ' im',
      first.columns + '×' + first.rows
    ].filter(Boolean).join(' · ');
    info.appendChild(meta);

    var volume = DCM.buildVolume(series);
    if (volume) {
      var tag = document.createElement('span');
      tag.className = 'si-tag';
      tag.textContent = 'MPR ' + num(volume.sliceSpacing, 2) + ' mm';
      info.appendChild(tag);
    }

    item.appendChild(info);
    item.addEventListener('click', function () { selectSeries(series); });
    drawThumbnail(thumb, series);
    return item;
  }

  function drawThumbnail(canvas, series) {
    var image = series.entries[Math.floor(series.entries.length / 2)].image;
    var window_ = DCM.image.defaultWindow(image);
    var lut = DCM.image.buildLut(image, window_.ww, window_.wc, false);
    var off = document.createElement('canvas');
    off.width = image.columns;
    off.height = image.rows;
    var offctx = off.getContext('2d');
    var data = offctx.createImageData(image.columns, image.rows);
    DCM.image.render(image, lut, data);
    offctx.putImageData(data, 0, 0);

    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    var scale = Math.min(canvas.width / image.columns, canvas.height / image.rows);
    var w = image.columns * scale;
    var h = image.rows * scale;
    ctx.drawImage(off, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    // La LUT cacheada corresponde a la miniatura; se limpia para que el
    // viewport la reconstruya con su propia ventana.
    image._lutCache = null;
  }

  function renderPatientCard(study) {
    if (!study) {
      dom.patientCard.className = 'card muted';
      dom.patientCard.textContent = 'Sin estudio cargado';
      return;
    }
    dom.patientCard.className = 'card';
    var rows = [
      ['ID', study.patientID],
      ['Nacim.', dicomDate(study.patientBirthDate)],
      ['Sexo', study.patientSex],
      ['Estudio', dicomDate(study.studyDate) + ' ' + dicomTime(study.studyTime)],
      ['Centro', study.institution]
    ].filter(function (row) { return row[1] && String(row[1]).trim(); });

    dom.patientCard.innerHTML = '';
    var name = document.createElement('div');
    name.className = 'name';
    name.textContent = study.patientName || 'Paciente sin nombre';
    dom.patientCard.appendChild(name);
    rows.forEach(function (row) {
      var div = document.createElement('div');
      div.className = 'row';
      var k = document.createElement('span');
      k.className = 'k';
      k.textContent = row[0];
      var v = document.createElement('span');
      v.className = 'v';
      v.textContent = row[1];
      div.appendChild(k);
      div.appendChild(v);
      dom.patientCard.appendChild(div);
    });
  }

  // ------------------------------------------------------ Seleccion serie

  function selectSeries(series) {
    stopCine();
    state.series = series;
    state.volume = DCM.buildVolume(series);

    if (state.volume) {
      state.frame = DCM.mpr.createFrame(state.volume);
      state.center = DCM.mpr.defaultCenter(state.volume);
      state.index = axialTrack().index;
    } else {
      state.frame = null;
      state.center = null;
      state.index = Math.floor(series.entries.length / 2);
    }

    applyPreset(state.presetId, true);

    Array.prototype.forEach.call(dom.seriesList.querySelectorAll('.series-item'), function (el) {
      el.classList.toggle('on', el.dataset.key === series.key);
    });

    if (!state.volume && series.volumeReason && state.layout !== '1x1') {
      noteOnce('vol:' + series.key, 'warn',
        'Sin reconstruccion MPR en "' + (series.seriesDescription || series.key) + '": ' +
        series.volumeReason);
    }

    buildLayout();
    updateSlider();
    update();
    showMetadataForCurrent();
  }

  function currentEntry() {
    if (!state.series) return null;
    var list = state.series.entries;
    return list[Math.max(0, Math.min(list.length - 1, state.index))] || null;
  }

  // ------------------------------------------------------------- Layout

  var PLANES = {
    '1x1': [{ plane: 'axial', title: 'Axial' }],
    '2x2': [
      { plane: 'axial', title: 'Axial' },
      { plane: 'coronal', title: 'Coronal' },
      { plane: 'sagittal', title: 'Sagital' },
      { plane: 'mip', title: 'MIP axial' }
    ],
    '1x3': [
      { plane: 'axial', title: 'Axial' },
      { plane: 'coronal', title: 'Coronal' },
      { plane: 'sagittal', title: 'Sagital' }
    ]
  };

  function buildLayout() {
    dom.grid.className = 'grid layout-' + state.layout;
    dom.grid.innerHTML = '';
    viewports = [];

    PLANES[state.layout].forEach(function (spec, index) {
      var cell = document.createElement('div');
      cell.className = 'vp';
      dom.grid.appendChild(cell);

      var viewport = new DCM.Viewport(cell, { plane: spec.plane, title: spec.title });
      viewport.canvas.tabIndex = 0;
      viewport.tool = state.tool;
      viewport.invert = state.invert;
      viewport.interpolate = state.smooth;
      viewport.emptyMessage = 'Sin reconstruccion disponible';

      var caption = document.createElement('div');
      caption.className = 'vp-title';
      caption.textContent = spec.title;
      cell.appendChild(caption);

      wireViewport(viewport, index);
      viewports.push(viewport);
    });

    state.activeViewport = 0;
    // El layout necesita un ciclo para tener tamano real antes de escalar.
    requestAnimationFrame(function () {
      viewports.forEach(function (v) { v.resize(); });
      update();
    });
  }

  function wireViewport(viewport, index) {
    viewport.on.activate = function () { setActiveViewport(index); };

    viewport.on.window = function (ww, wc) {
      state.ww = ww;
      state.wc = wc;
      state.presetId = 'custom';
      syncWindowInputs();
      update();
    };

    viewport.on.scroll = function (delta) {
      setActiveViewport(index);
      stepAlong(viewport.plane, delta);
    };

    viewport.on.crosshair = function (point) {
      var view = state.views[viewport.plane];
      if (!view || !view.mapToPatient) return;
      // El punto pinchado esta dentro del plano, asi que basta con llevarlo a
      // milimetros de paciente: la posicion a lo largo de la normal no cambia.
      state.center = view.mapToPatient(point.x, point.y);
      state.index = axialTrack().index;
      updateSlider();
      update();
    };

    viewport.on.rotate = function (angle) {
      setActiveViewport(index);
      rotateFrame(viewport.plane, angle);
    };

    viewport.on.cursor = function (point, value) {
      if (!point) {
        dom.cursorReadout.textContent = '';
        return;
      }
      var image = viewport.image;
      var parts = [Math.floor(point.x) + ', ' + Math.floor(point.y)];
      if (!isNaN(value)) {
        parts.push(num(value, 1) + (image.unit ? ' ' + image.unit : ''));
      }
      dom.cursorReadout.textContent = parts.join('   |   ');
    };

    viewport.on.annotations = function () {
      renderMeasurements();
    };

    viewport.on.view = function () { updateOverlays(); };
  }

  function setActiveViewport(index) {
    state.activeViewport = index;
    viewports.forEach(function (v, i) {
      v.active = i === index;
      v.render();
    });
  }

  // ----------------------------------------------------- Navegacion cortes

  /** Recorrido del centro a lo largo de la normal de la vista axial. */
  function axialTrack() {
    if (!state.volume) return null;
    return DCM.mpr.track(state.volume, DCM.mpr.viewBasis(state.frame, 'axial'), state.center);
  }

  function sliceCount() {
    if (state.volume) {
      var track = axialTrack();
      return track ? track.count : 0;
    }
    return state.series ? state.series.entries.length : 0;
  }

  function setIndex(value) {
    if (state.volume) {
      var track = axialTrack();
      var next = Math.max(0, Math.min(track.count - 1, value));
      if (next === track.index) return;
      state.center = track.at(next);
      state.index = next;
    } else {
      var clamped = Math.max(0, Math.min(state.series.entries.length - 1, value));
      if (clamped === state.index) return;
      state.index = clamped;
    }
    updateSlider();
    update();
  }

  /** Desplaza el centro a lo largo de la normal de un plano concreto. */
  function stepAlong(plane, delta) {
    if (!state.volume) { setIndex(state.index + delta); return; }
    var basis = DCM.mpr.viewBasis(state.frame, plane === 'mip' ? 'axial' : plane);
    var track = DCM.mpr.track(state.volume, basis, state.center);
    state.center = track.at(track.index + delta);
    state.index = axialTrack().index;
    updateSlider();
    update();
  }

  function rotateFrame(plane, angle) {
    if (!state.volume || !angle) return;
    var basis = DCM.mpr.viewBasis(state.frame, plane === 'mip' ? 'axial' : plane);
    state.frame = DCM.mpr.rotateFrame(state.frame, basis.normal, angle);
    state.index = axialTrack().index;
    updateSlider();
    update();
  }

  function resetOrientation() {
    if (!state.volume) return;
    state.frame = DCM.mpr.createFrame(state.volume);
    state.index = axialTrack().index;
    updateSlider();
    update();
    status('Orientacion restablecida a los planos nativos de la serie.');
  }

  function updateSlider() {
    var count = sliceCount();
    dom.sliceSlider.max = Math.max(0, count - 1);
    dom.sliceSlider.value = state.index;
    dom.sliceSlider.disabled = count <= 1;

    var position = '';
    if (state.volume && state.center) {
      var view = state.views.axial;
      if (view && view.native === 'axial') {
        var image = DCM.axialSlice(state.volume, DCM.toVoxel(state.volume, state.center).k);
        if (image.sliceLocation !== undefined) {
          position = '  ' + num(image.sliceLocation, 1) + ' mm';
        }
      } else if (view) {
        position = '  ' + num(DCM.vec.dot(state.center, view.basis.normal), 1) + ' mm';
      }
    }
    dom.sliceLabel.textContent = count
      ? (state.index + 1) + ' / ' + count + position
      : '--';
  }

  // ------------------------------------------------------------- Ventana

  function applyPreset(presetId, force) {
    var reference = state.series && state.series.entries[0].image;
    if (!reference) return;
    if (presetId === 'custom' && !force) return;
    var window_ = DCM.image.presetWindow(reference, presetId === 'custom' ? 'default' : presetId);
    state.presetId = presetId === 'custom' ? 'default' : presetId;
    state.ww = window_.ww;
    state.wc = window_.wc;
    dom.presetSelect.value = state.presetId;
    syncWindowInputs();
  }

  function syncWindowInputs() {
    dom.wwInput.value = Math.round(state.ww);
    dom.wcInput.value = Math.round(state.wc);
    if (state.presetId === 'custom') dom.presetSelect.value = '';
  }

  // ------------------------------------------------------------ Actualizar

  /** Recalcula la vista de cada plano presente en el layout actual. */
  function computeViews() {
    state.views = Object.create(null);
    if (!state.volume || !state.frame) return;
    viewports.forEach(function (viewport) {
      state.views[viewport.plane] = DCM.mpr.view(
        state.volume, state.frame, state.center, viewport.plane,
        { slab: state.slab, slabMode: 'max', interpolate: true }
      );
    });
  }

  function imageForPlane(plane) {
    if (!state.volume) {
      if (plane !== 'axial') return null;
      var entry = currentEntry();
      return entry ? entry.image : null;
    }
    var view = state.views[plane];
    return view ? view.image : null;
  }

  /**
   * Clave de las anotaciones de un plano. Incluye la orientacion y la
   * posicion a lo largo de la normal: al reorientar el marco, las mediciones
   * hechas sobre el plano anterior dejan de mostrarse, y vuelven a aparecer
   * si se recupera esa orientacion. No se borran nunca.
   */
  function annotationKey(plane) {
    if (!state.series) return 'none';
    var prefix = state.series.key + '|' + plane + '|';
    if (!state.volume) return prefix + state.index;
    var view = state.views[plane];
    if (!view) return prefix + state.index;
    var normal = view.basis.normal;
    var signature = normal.map(function (c) { return c.toFixed(3); }).join(',');
    var offset = DCM.vec.dot(state.center, normal);
    return prefix + signature + '|' + offset.toFixed(2);
  }

  function annotationsFor(plane) {
    var key = annotationKey(plane);
    if (!state.annotations[key]) {
      state.annotations[key] = [];
      state.annotationMeta[key] = {
        plane: plane,
        label: planeLabel(plane),
        center: state.center ? state.center.slice() : null,
        frame: state.frame ? {
          x: state.frame.x.slice(), y: state.frame.y.slice(), z: state.frame.z.slice()
        } : null,
        index: state.index
      };
    }
    return state.annotations[key];
  }

  function planeLabel(plane) {
    var names = { axial: 'Axial', coronal: 'Coronal', sagittal: 'Sagital', mip: 'MIP' };
    var view = state.views[plane];
    var base = names[plane] || plane;
    if (view && view.obliquity > 0.5) return base + ' oblicuo ' + Math.round(view.obliquity) + '°';
    if (!state.volume) return base + ' ' + (state.index + 1);
    return base + ' ' + (state.index + 1);
  }

  /** Punto y lineas de interseccion que dibuja el viewport. */
  function referenceFor(plane) {
    if (!state.volume) return null;
    var view = state.views[plane];
    if (!view) return null;
    return {
      point: view.cross,
      lines: DCM.mpr.referenceLines(state.frame, plane)
    };
  }

  function axisLabel(v) {
    var ax = Math.abs(v[0]), ay = Math.abs(v[1]), az = Math.abs(v[2]);
    if (ax >= ay && ax >= az) return v[0] > 0 ? 'I' : 'D';
    if (ay >= az) return v[1] > 0 ? 'P' : 'A';
    return v[2] > 0 ? 'Cr' : 'Ca';
  }

  function negate(v) { return [-v[0], -v[1], -v[2]]; }

  /**
   * Etiquetas de orientacion tomadas de la base de la vista, asi que siguen
   * siendo correctas con el plano oblicuo: indican la direccion anatomica
   * dominante de cada borde.
   */
  function orientationLabels(plane) {
    if (state.volume) {
      var view = state.views[plane];
      if (!view) return null;
      return {
        right: axisLabel(view.basis.right), left: axisLabel(negate(view.basis.right)),
        bottom: axisLabel(view.basis.down), top: axisLabel(negate(view.basis.down))
      };
    }
    var reference = state.series && state.series.entries[0].image;
    if (!reference || !reference.orientation) return null;
    var rowDir = reference.orientation.slice(0, 3);
    var colDir = reference.orientation.slice(3, 6);
    return {
      right: axisLabel(rowDir), left: axisLabel(negate(rowDir)),
      bottom: axisLabel(colDir), top: axisLabel(negate(colDir))
    };
  }

  function update() {
    computeViews();

    viewports.forEach(function (viewport) {
      var image = imageForPlane(viewport.plane);
      viewport.ww = state.ww;
      viewport.wc = state.wc;
      viewport.invert = state.invert;
      viewport.interpolate = state.smooth;
      viewport.tool = state.tool;
      viewport.reference = image ? referenceFor(viewport.plane) : null;
      viewport.orientationLabels = image ? orientationLabels(viewport.plane) : null;

      var annotations = image ? annotationsFor(viewport.plane) : [];
      annotations.forEach(function (annotation) {
        DCM.tools.measure(annotation, image);
      });
      viewport.setAnnotations(annotations);

      viewport.emptyMessage = (state.series && state.series.volumeReason) ||
        'Sin reconstruccion disponible';
      viewport.setImage(image);
    });

    pruneAnnotations();
    updateOverlays();
    renderMeasurements();
  }

  /** Quita las listas vacias que deja al vuelo el cambio de plano. */
  function pruneAnnotations() {
    Object.keys(state.annotations).forEach(function (key) {
      if (!state.annotations[key].length) {
        delete state.annotations[key];
        delete state.annotationMeta[key];
      }
    });
  }

  function updateOverlays() {
    var study = state.series ? state.series.study : null;
    var entry = currentEntry();

    viewports.forEach(function (viewport) {
      if (!viewport.image) { viewport.render(); return; }
      var image = viewport.image;
      var topLeft = [];
      var topRight = [];
      var bottomLeft = [];
      var bottomRight = [];

      if (study) {
        topLeft.push(study.patientName || 'Paciente sin nombre');
        var line2 = [study.patientID, study.patientSex, entry && entry.text.patientAge]
          .filter(Boolean).join('  ');
        if (line2) topLeft.push(line2);
        if (study.institution) topLeft.push(study.institution);

        topRight.push(study.studyDescription || '');
        topRight.push(state.series.seriesDescription || state.series.protocol || '');
        topRight.push(dicomDate(study.studyDate) + '  ' + dicomTime(study.studyTime));
      }

      var view = state.views[viewport.plane];
      var oblique = view && view.obliquity > 0.5;
      bottomLeft.push(viewport.title + (oblique
        ? '  oblicuo ' + view.obliquity.toFixed(1) + '°'
        : ''));

      if (state.volume && view) {
        var track = DCM.mpr.track(state.volume, view.basis, state.center);
        bottomLeft.push('Corte ' + (track.index + 1) + ' / ' + track.count);
      } else {
        bottomLeft.push('Corte ' + (state.index + 1) + ' / ' + sliceCount());
      }
      var geometry = [];
      if (image.hasRealSpacing) {
        geometry.push(num(image.colSpacing, 2) + '×' + num(image.rowSpacing, 2) + ' mm/px');
      }
      if (image.sliceThickness) geometry.push('esp ' + num(image.sliceThickness, 2) + ' mm');
      if (geometry.length) bottomLeft.push(geometry.join('  '));
      // El corte nativo se etiqueta con el nombre del plano, que ya esta en
      // la primera linea; solo se anade si aporta algo (un MIP, por ejemplo).
      if (image.label && image.label !== viewport.title) bottomLeft.push(image.label);

      bottomRight.push('A ' + Math.round(state.ww) + '  C ' + Math.round(state.wc) +
        (image.unit ? ' ' + image.unit : ''));
      bottomRight.push('Zoom ' + Math.round(viewport.zoom * 100) + '%');
      var technique = [state.series && state.series.modality, entry && entry.text.kernel,
        entry && entry.text.kvp ? entry.text.kvp + ' kV' : ''].filter(Boolean).join('  ');
      if (technique) bottomRight.push(technique);
      if (image.approximate) bottomRight.push('! valores aproximados');
      if (view && !view.native) bottomRight.push('remuestreado ' + num(image.colSpacing, 2) + ' mm');
      if (state.volume && state.volume.irregular && (!view || !view.native || oblique)) {
        bottomRight.push('! espaciado irregular');
      }

      viewport.overlay = {
        topLeft: topLeft.filter(Boolean),
        topRight: topRight.filter(Boolean),
        bottomLeft: bottomLeft.filter(Boolean),
        bottomRight: bottomRight.filter(Boolean)
      };
      viewport.render();
    });
  }

  // -------------------------------------------------------- Mediciones UI

  function renderMeasurements() {
    var keys = Object.keys(state.annotations).filter(function (key) {
      return state.annotations[key].length;
    });
    var total = keys.reduce(function (sum, key) {
      return sum + state.annotations[key].length;
    }, 0);

    dom.measureCount.textContent = total + ' medicion' + (total === 1 ? '' : 'es');

    if (!total) {
      dom.measureList.className = 'measure-list muted';
      dom.measureList.textContent = 'Sin mediciones.';
      return;
    }

    dom.measureList.className = 'measure-list';
    dom.measureList.innerHTML = '';

    keys.forEach(function (key) {
      var meta = state.annotationMeta[key];
      var where = meta ? meta.label : key;
      state.annotations[key].forEach(function (annotation) {
        var item = document.createElement('div');
        item.className = 'measure-item';

        var head = document.createElement('div');
        head.className = 'mi-head';
        var type = document.createElement('span');
        type.className = 'mi-type';
        type.textContent = DCM.tools.types[annotation.type].label;
        var place = document.createElement('span');
        place.className = 'mi-where';
        place.textContent = where;
        var del = document.createElement('button');
        del.className = 'mi-del';
        del.textContent = '×';
        del.title = 'Borrar';
        del.addEventListener('click', function (event) {
          event.stopPropagation();
          var list = state.annotations[key];
          var at = list.indexOf(annotation);
          if (at >= 0) list.splice(at, 1);
          update();
        });
        head.appendChild(type);
        head.appendChild(place);
        head.appendChild(del);
        item.appendChild(head);

        var text = document.createElement('div');
        text.className = 'mi-text';
        text.textContent = (annotation.text || []).join('   ');
        item.appendChild(text);

        item.addEventListener('click', function () { goToAnnotation(key); });
        dom.measureList.appendChild(item);
      });
    });
  }

  /**
   * Vuelve exactamente al plano donde se tomo la medicion, recuperando tanto
   * la posicion como la orientacion que habia en ese momento.
   */
  function goToAnnotation(key) {
    var meta = state.annotationMeta[key];
    if (!meta) return;
    if (meta.center && meta.frame) {
      state.center = meta.center.slice();
      state.frame = {
        x: meta.frame.x.slice(), y: meta.frame.y.slice(), z: meta.frame.z.slice()
      };
      state.index = axialTrack().index;
    } else {
      state.index = meta.index || 0;
    }
    updateSlider();
    update();
  }

  // --------------------------------------------------------- Metadatos UI

  var metaEntries = [];

  async function showMetadataForCurrent() {
    var entry = currentEntry();
    if (!entry) return;
    dom.metaTable.className = 'meta-table muted';
    dom.metaTable.textContent = 'Leyendo cabecera...';
    try {
      var buffer = await entry.file.arrayBuffer();
      var parsed = await DCM.parse(buffer);
      metaEntries = [];
      if (parsed.meta) {
        metaEntries = metaEntries.concat(parsed.meta.toEntries(200).map(function (row) {
          row.group = 'meta';
          return row;
        }));
      }
      metaEntries = metaEntries.concat(parsed.dataset.toEntries(200));
      renderMetadata();
    } catch (err) {
      dom.metaTable.className = 'meta-table muted';
      dom.metaTable.textContent = 'No se pudo leer la cabecera: ' + err.message;
    }
  }

  function renderMetadata() {
    var filter = dom.metaFilter.value.trim().toLowerCase();
    var rows = metaEntries.filter(function (row) {
      if (!filter) return true;
      return row.name.toLowerCase().indexOf(filter) >= 0 ||
             row.tag.toLowerCase().indexOf(filter) >= 0 ||
             String(row.value).toLowerCase().indexOf(filter) >= 0;
    });

    if (!rows.length) {
      dom.metaTable.className = 'meta-table muted';
      dom.metaTable.textContent = filter ? 'Sin coincidencias.' : 'Sin metadatos.';
      return;
    }

    dom.metaTable.className = 'meta-table';
    var html = rows.map(function (row) {
      return '<div class="meta-row depth-' + Math.min(2, row.depth) + '">' +
        '<div class="mr-top">' +
        '<span class="mr-tag">' + row.tag.slice(0, 4) + ',' + row.tag.slice(4) + '</span>' +
        '<span class="mr-name">' + escapeHtml(row.name) + '</span>' +
        '<span class="mr-vr">' + row.vr + '</span>' +
        '</div>' +
        (row.value ? '<div class="mr-value">' + escapeHtml(row.value) + '</div>' : '') +
        '</div>';
    }).join('');
    dom.metaTable.innerHTML = html;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---------------------------------------------------------------- Cine

  function startCine() {
    if (state.cine) return;
    var fps = Math.max(1, Math.min(60, parseInt(dom.fpsInput.value, 10) || 12));
    dom.btnCine.classList.add('on');
    setCineIcon('#i-pause');
    state.cine = setInterval(function () {
      var next = state.index + 1;
      state.index = next >= sliceCount() ? 0 : next;
      updateSlider();
      update();
    }, 1000 / fps);
  }

  function stopCine() {
    if (!state.cine) return;
    clearInterval(state.cine);
    state.cine = null;
    dom.btnCine.classList.remove('on');
    setCineIcon('#i-play');
  }

  /**
   * Cambia el icono del boton de cine sin tocar su contenido, que antes se
   * reescribia entero con innerHTML y se llevaba por delante el <svg>.
   */
  function setCineIcon(id) {
    var use = dom.cineIcon;
    if (use) use.setAttribute('href', id);
  }

  function toggleCine() {
    if (state.cine) stopCine(); else startCine();
  }

  // ------------------------------------------------------- Arrastrar/soltar

  async function collectEntry(entry, files, depth) {
    if (!entry || depth > 12) return;
    if (entry.isFile) {
      await new Promise(function (resolve) {
        entry.file(function (file) { files.push(file); resolve(); }, resolve);
      });
      return;
    }
    if (entry.isDirectory) {
      var reader = entry.createReader();
      var batch;
      do {
        batch = await new Promise(function (resolve) {
          reader.readEntries(function (results) { resolve(results); }, function () { resolve([]); });
        });
        for (var i = 0; i < batch.length; i++) {
          await collectEntry(batch[i], files, depth + 1);
        }
      } while (batch.length);
    }
  }

  async function handleDrop(event) {
    event.preventDefault();
    dom.dropzone.classList.remove('dragging');
    var items = event.dataTransfer.items;
    var files = [];

    if (items && items.length && items[0].webkitGetAsEntry) {
      var roots = [];
      for (var i = 0; i < items.length; i++) {
        var entry = items[i].webkitGetAsEntry();
        if (entry) roots.push(entry);
      }
      status('Recorriendo carpetas...');
      for (var k = 0; k < roots.length; k++) await collectEntry(roots[k], files, 0);
    }
    if (!files.length && event.dataTransfer.files) {
      files = Array.prototype.slice.call(event.dataTransfer.files);
    }
    if (files.length) await loadFiles(files);
  }

  // ------------------------------------------------------------- Atajos

  var TOOL_KEYS = {
    w: 'wwwl', p: 'pan', z: 'zoom', c: 'crosshair', g: 'rotate',
    '1': 'probe', '2': 'length', '3': 'angle', '4': 'rect', '5': 'ellipse'
  };

  function setTool(tool) {
    state.tool = tool;
    viewports.forEach(function (viewport) { viewport.tool = tool; });
    Array.prototype.forEach.call(dom.toolButtons.querySelectorAll('.tool'), function (button) {
      button.classList.toggle('on', button.dataset.tool === tool);
    });
  }

  function onKeyDown(event) {
    var target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' ||
                   target.tagName === 'TEXTAREA')) {
      return;
    }
    var active = viewports[state.activeViewport];
    var key = event.key;

    if (key === 'ArrowDown' || key === 'ArrowRight') { setIndex(state.index + 1); event.preventDefault(); return; }
    if (key === 'ArrowUp' || key === 'ArrowLeft') { setIndex(state.index - 1); event.preventDefault(); return; }
    if (key === 'PageDown') { setIndex(state.index + 10); event.preventDefault(); return; }
    if (key === 'PageUp') { setIndex(state.index - 10); event.preventDefault(); return; }
    if (key === 'Home') { setIndex(0); event.preventDefault(); return; }
    if (key === 'End') { setIndex(sliceCount() - 1); event.preventDefault(); return; }
    if (key === ' ') { toggleCine(); event.preventDefault(); return; }
    if (key === 'Delete' || key === 'Backspace') {
      if (active && active.deleteSelected()) { renderMeasurements(); event.preventDefault(); }
      return;
    }
    if (key === 'Escape') {
      if (active) active.cancelDraft();
      dom.helpDialog.classList.add('hidden');
      return;
    }

    var lower = key.toLowerCase();
    if (TOOL_KEYS[lower]) { setTool(TOOL_KEYS[lower]); event.preventDefault(); return; }
    if (lower === 'i') { toggleInvert(); event.preventDefault(); return; }
    if (lower === 'o') { resetOrientation(); event.preventDefault(); return; }
    if (lower === 'r') { viewports.forEach(function (v) { v.reset(); }); event.preventDefault(); }
  }

  function toggleInvert() {
    state.invert = !state.invert;
    dom.btnInvert.classList.toggle('on', state.invert);
    update();
  }

  // ---------------------------------------------------------------- Init

  function savePng() {
    var viewport = viewports[state.activeViewport];
    if (!viewport || !viewport.image) return;
    viewport.canvas.toBlob(function (blob) {
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      var name = [state.series && state.series.modality,
        state.series && state.series.seriesNumber,
        viewport.plane, state.index + 1].filter(Boolean).join('-');
      link.href = url;
      link.download = (name || 'captura') + '.png';
      link.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    }, 'image/png');
  }

  function init() {
    [
      'btnOpenFolder', 'btnOpenFiles', 'btnPhantom', 'folderInput', 'filesInput', 'toolButtons',
      'presetSelect', 'wwInput', 'wcInput', 'layoutSelect', 'slabInput', 'slabField',
      'btnCine', 'cineIcon', 'fpsInput', 'btnInvert', 'btnSmooth', 'btnReset', 'btnSavePng',
      'btnResetOrientation',
      'btnHelp', 'patientCard', 'seriesCount', 'seriesList', 'grid', 'dropzone',
      'sliceSlider', 'sliceLabel', 'btnPrev', 'btnNext', 'metaFilter', 'metaTable',
      'measureCount', 'measureList', 'btnClearAnnotations', 'logList',
      'statusMessage', 'cursorReadout', 'progressWrap', 'progressBar',
      'helpDialog', 'btnCloseHelp', 'tabs'
    ].forEach(function (id) { dom[id] = $(id); });

    DCM.image.presets.forEach(function (preset) {
      var option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.label + (preset.ww ? '  (' + preset.ww + '/' + preset.wc + ')' : '');
      dom.presetSelect.appendChild(option);
    });
    dom.presetSelect.value = 'default';

    dom.btnOpenFolder.addEventListener('click', function () { dom.folderInput.click(); });
    dom.btnOpenFiles.addEventListener('click', function () { dom.filesInput.click(); });
    dom.folderInput.addEventListener('change', function (e) {
      loadFiles(e.target.files); e.target.value = '';
    });
    dom.filesInput.addEventListener('change', function (e) {
      loadFiles(e.target.files); e.target.value = '';
    });
    dom.btnPhantom.addEventListener('click', async function () {
      status('Generando estudio sintetico...');
      dom.btnPhantom.disabled = true;
      try {
        await DCM.phantom.load();
      } catch (err) {
        log('error', 'No se pudo generar el fantoma: ' + err.message);
        status('Error generando el fantoma.');
      }
      dom.btnPhantom.disabled = false;
    });

    dom.toolButtons.addEventListener('click', function (event) {
      var button = event.target.closest('.tool');
      if (button) setTool(button.dataset.tool);
    });

    dom.presetSelect.addEventListener('change', function () {
      applyPreset(dom.presetSelect.value, true);
      update();
    });
    dom.wwInput.addEventListener('change', function () {
      state.ww = Math.max(1, parseFloat(dom.wwInput.value) || 1);
      state.presetId = 'custom';
      update();
    });
    dom.wcInput.addEventListener('change', function () {
      state.wc = parseFloat(dom.wcInput.value) || 0;
      state.presetId = 'custom';
      update();
    });

    dom.layoutSelect.addEventListener('change', function () {
      state.layout = dom.layoutSelect.value;
      dom.slabField.style.display = state.layout === '2x2' ? '' : 'none';
      buildLayout();
    });
    dom.slabField.style.display = 'none';
    dom.slabInput.addEventListener('change', function () {
      state.slab = Math.max(0, parseFloat(dom.slabInput.value) || 0);
      update();
    });

    dom.btnCine.addEventListener('click', toggleCine);
    dom.fpsInput.addEventListener('change', function () {
      if (state.cine) { stopCine(); startCine(); }
    });

    dom.btnInvert.addEventListener('click', toggleInvert);
    dom.btnSmooth.addEventListener('click', function () {
      state.smooth = !state.smooth;
      dom.btnSmooth.classList.toggle('on', state.smooth);
      update();
    });
    dom.btnReset.addEventListener('click', function () {
      viewports.forEach(function (v) { v.reset(); });
    });
    dom.btnSavePng.addEventListener('click', savePng);
    dom.btnHelp.addEventListener('click', function () {
      dom.helpDialog.classList.remove('hidden');
    });
    dom.btnCloseHelp.addEventListener('click', function () {
      dom.helpDialog.classList.add('hidden');
    });

    dom.sliceSlider.addEventListener('input', function () {
      setIndex(parseInt(dom.sliceSlider.value, 10));
    });
    dom.btnPrev.addEventListener('click', function () { setIndex(state.index - 1); });
    dom.btnNext.addEventListener('click', function () { setIndex(state.index + 1); });

    dom.metaFilter.addEventListener('input', renderMetadata);
    dom.btnClearAnnotations.addEventListener('click', function () {
      state.annotations = Object.create(null);
      state.annotationMeta = Object.create(null);
      update();
    });
    dom.btnResetOrientation.addEventListener('click', resetOrientation);

    dom.tabs.addEventListener('click', function (event) {
      var tab = event.target.closest('.tab');
      if (!tab) return;
      Array.prototype.forEach.call(dom.tabs.querySelectorAll('.tab'), function (t) {
        t.classList.toggle('on', t === tab);
      });
      $('tabMeta').classList.toggle('hidden', tab.dataset.tab !== 'meta');
      $('tabMeasure').classList.toggle('hidden', tab.dataset.tab !== 'measure');
      $('tabLog').classList.toggle('hidden', tab.dataset.tab !== 'log');
    });

    ['dragenter', 'dragover'].forEach(function (name) {
      global.addEventListener(name, function (event) {
        event.preventDefault();
        dom.dropzone.classList.remove('hidden');
        dom.dropzone.classList.add('dragging');
      });
    });
    global.addEventListener('dragleave', function (event) {
      if (event.relatedTarget) return;
      dom.dropzone.classList.remove('dragging');
      if (state.entries.length) dom.dropzone.classList.add('hidden');
    });
    global.addEventListener('drop', handleDrop);

    document.addEventListener('keydown', onKeyDown);

    var resizeTimer = null;
    global.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        viewports.forEach(function (v) { v.resize(); });
      }, 80);
    });

    setTool('wwwl');
    buildLayout();
    renderLog();
    status('Listo. Abre una carpeta de estudio para empezar.');

    // Se expone para depuracion y para cargar datos desde consola.
    // `viewports` es un getter porque buildLayout() reemplaza el array entero
    // cada vez que cambia el layout.
    global.lector = {
      state: state,
      get viewports() { return viewports; },
      loadFiles: loadFiles,
      update: update,
      resetOrientation: resetOrientation
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
