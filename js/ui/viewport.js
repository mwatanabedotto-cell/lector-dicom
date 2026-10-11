/*
 * Viewport: dibuja una imagen en un canvas y gestiona la interaccion.
 *
 * Se trabaja en dos espacios:
 *   - imagen: (columna, fila) con decimales
 *   - display: pixeles CSS del canvas
 *
 * El escalado tiene en cuenta el espaciado fisico, asi que una imagen con
 * pixeles no cuadrados (habitual en coronal/sagital reconstruidos) se dibuja
 * con la proporcion correcta.
 *
 * Botones: izquierdo = herramienta activa, central = desplazar,
 * derecho = ventana/nivel, rueda = cambiar de corte, Ctrl+rueda = zoom.
 */
(function (global) {
  'use strict';

  var DCM = global.DCM = global.DCM || {};

  var ACCENT = '#ffd479';
  var SELECTED = '#7ee0ff';

  function Viewport(container, options) {
    options = options || {};
    this.container = container;
    this.plane = options.plane || 'axial';
    this.title = options.title || '';

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'vp-canvas';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    // Canvas intermedio al tamano nativo de la imagen: ahi se escribe el
    // ImageData ventaneado y de ahi se escala al canvas visible.
    this.offscreen = document.createElement('canvas');
    this.offctx = this.offscreen.getContext('2d', { willReadFrequently: true });
    this.imageData = null;
    this.renderedKey = null;

    this.image = null;
    this.ww = 400;
    this.wc = 40;
    this.invert = false;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.interpolate = true;
    this.showOverlay = true;
    this.showAnnotations = true;
    this.showReference = true;
    this.tool = 'wwwl';
    this.annotations = [];
    // { point: {x, y} en coordenadas de imagen, lines: [{dx, dy, color}] }
    this.reference = null;
    this.overlay = { topLeft: [], topRight: [], bottomLeft: [], bottomRight: [] };
    this.orientationLabels = null;
    this.active = false;
    this.emptyMessage = 'Sin imagen';

    this.on = {
      window: null,        // (ww, wc)
      scroll: null,        // (delta)
      crosshair: null,     // ({x, y})
      rotate: null,        // (deltaRadianes) giro alrededor de la normal
      cursor: null,        // ({x, y} | null, value)
      annotations: null,   // (annotations)
      activate: null,      // ()
      view: null           // () cuando cambia zoom/pan
    };

    this._pointer = null;
    this._selected = null;
    this._draft = null;
    this._dpr = 1;

    bindEvents(this);
  }

  // ------------------------------------------------------------ Geometria

  /** Escala en pixeles CSS por milimetro para que la imagen quepa entera. */
  Viewport.prototype.fitScale = function () {
    if (!this.image) return 1;
    var widthMM = this.image.columns * (this.image.colSpacing || 1);
    var heightMM = this.image.rows * (this.image.rowSpacing || 1);
    var w = this.canvas.clientWidth || 1;
    var h = this.canvas.clientHeight || 1;
    if (!widthMM || !heightMM) return 1;
    return Math.min(w / widthMM, h / heightMM) * 0.98;
  };

  Viewport.prototype.transform = function () {
    var scale = this.fitScale() * this.zoom;
    var sx = (this.image.colSpacing || 1) * scale;
    var sy = (this.image.rowSpacing || 1) * scale;
    var w = this.canvas.clientWidth || 1;
    var h = this.canvas.clientHeight || 1;
    return {
      sx: sx,
      sy: sy,
      originX: w / 2 - (this.image.columns * sx) / 2 + this.panX,
      originY: h / 2 - (this.image.rows * sy) / 2 + this.panY,
      scale: scale
    };
  };

  Viewport.prototype.toDisplay = function (point) {
    var t = this.transform();
    return { x: t.originX + point.x * t.sx, y: t.originY + point.y * t.sy };
  };

  Viewport.prototype.toImage = function (point) {
    var t = this.transform();
    return { x: (point.x - t.originX) / t.sx, y: (point.y - t.originY) / t.sy };
  };

  Viewport.prototype.reset = function () {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.render();
    if (this.on.view) this.on.view();
  };

  // ------------------------------------------------------------- Contenido

  Viewport.prototype.setImage = function (image) {
    if (this.image !== image) this.renderedKey = null;
    this.image = image;
    // paintPixels() redimensiona el canvas intermedio cuando hace falta.
    this.render();
  };

  Viewport.prototype.setWindow = function (ww, wc) {
    this.ww = Math.max(1, ww);
    this.wc = wc;
    this.render();
  };

  Viewport.prototype.setAnnotations = function (list) {
    this.annotations = list || [];
    this._selected = null;
    this.render();
  };

  Viewport.prototype.resize = function () {
    var dpr = global.devicePixelRatio || 1;
    var w = this.canvas.clientWidth;
    var h = this.canvas.clientHeight;
    if (!w || !h) return;
    var needed = Math.round(w * dpr) !== this.canvas.width ||
                 Math.round(h * dpr) !== this.canvas.height;
    if (needed) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this._dpr = dpr;
    }
    this.render();
  };

  // ------------------------------------------------------------- Dibujado

  Viewport.prototype.render = function () {
    var ctx = this.ctx;
    var w = this.canvas.clientWidth;
    var h = this.canvas.clientHeight;
    if (!w || !h) return;
    if (this.canvas.width !== Math.round(w * this._dpr)) this.resize();

    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    if (!this.image) {
      ctx.fillStyle = '#4a5568';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.emptyMessage, w / 2, h / 2);
      ctx.textAlign = 'left';
      this.drawFrame(ctx, w, h);
      return;
    }

    this.paintPixels();

    var t = this.transform();
    ctx.imageSmoothingEnabled = this.interpolate;
    ctx.drawImage(this.offscreen, t.originX, t.originY,
                  this.image.columns * t.sx, this.image.rows * t.sy);

    if (this.showReference && this.reference) this.drawReference(ctx, t, w, h);
    if (this.showAnnotations) this.drawAnnotations(ctx);
    if (this.showOverlay) this.drawOverlay(ctx, w, h, t);
    this.drawFrame(ctx, w, h);
  };

  /** Rellena el canvas intermedio solo si cambio la imagen o la ventana. */
  Viewport.prototype.paintPixels = function () {
    var key = [
      this.image.sopInstanceUID || this.image.label || '',
      this.image.frameIndex, this.image.rows, this.image.columns,
      this.ww, this.wc, this.invert
    ].join('|');
    if (key === this.renderedKey) return;

    if (!this.imageData ||
        this.imageData.width !== this.image.columns ||
        this.imageData.height !== this.image.rows) {
      this.offscreen.width = this.image.columns;
      this.offscreen.height = this.image.rows;
      this.imageData = this.offctx.createImageData(this.image.columns, this.image.rows);
    }

    var lut = DCM.image.buildLut(this.image, this.ww, this.wc, this.invert);
    DCM.image.render(this.image, lut, this.imageData);
    this.offctx.putImageData(this.imageData, 0, 0);
    this.renderedKey = key;
  };

  Viewport.prototype.drawFrame = function (ctx, w, h) {
    ctx.strokeStyle = this.active ? '#3d7dd8' : '#1b2230';
    ctx.lineWidth = this.active ? 2 : 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  };

  /**
   * Lineas de referencia: cada una es la interseccion de otro plano con este,
   * dibujada en el color de ese plano. Cuando el marco esta sin rotar salen
   * horizontal y vertical; al reorientar, giran.
   */
  Viewport.prototype.drawReference = function (ctx, t, w, h) {
    var reference = this.reference;
    var p = {
      x: t.originX + reference.point.x * t.sx,
      y: t.originY + reference.point.y * t.sy
    };
    var span = Math.sqrt(w * w + h * h);
    var gap = 14;

    ctx.save();
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);

    (reference.lines || []).forEach(function (line) {
      var length = Math.sqrt(line.dx * line.dx + line.dy * line.dy) || 1;
      // La direccion viene en el espacio de la imagen; el escalado no uniforme
      // del viewport (pixeles no cuadrados) hay que aplicarlo aqui.
      var ux = (line.dx / length) * t.sx;
      var uy = (line.dy / length) * t.sy;
      var un = Math.sqrt(ux * ux + uy * uy) || 1;
      ux /= un; uy /= un;

      ctx.strokeStyle = line.color;
      ctx.globalAlpha = 0.65;
      ctx.beginPath();
      ctx.moveTo(p.x - ux * span, p.y - uy * span);
      ctx.lineTo(p.x - ux * gap, p.y - uy * gap);
      ctx.moveTo(p.x + ux * gap, p.y + uy * gap);
      ctx.lineTo(p.x + ux * span, p.y + uy * span);
      ctx.stroke();
    });

    ctx.setLineDash([]);
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  };

  Viewport.prototype.drawAnnotations = function (ctx) {
    var self = this;
    var toDisplay = function (point) { return self.toDisplay(point); };
    var style = {
      font: '11px ui-monospace, Menlo, Consolas, monospace',
      lineHeight: 13,
      lineWidth: 1.5,
      showHandles: true
    };

    var list = this.annotations.concat(this._draft ? [this._draft] : []);
    for (var i = 0; i < list.length; i++) {
      var annotation = list[i];
      var selected = annotation === this._selected;
      style.color = selected ? SELECTED : ACCENT;
      style.textColor = '#e8edf4';
      style.handleColor = selected ? SELECTED : '#ffffff';
      DCM.tools.draw(ctx, annotation, toDisplay, style);
    }
  };

  Viewport.prototype.drawOverlay = function (ctx, w, h, t) {
    ctx.save();
    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 3;
    ctx.fillStyle = '#c9d4e2';

    var pad = 6;
    var lh = 13;
    var i;

    // Cada esquina dispone de media anchura menos un canal central. En un
    // panel estrecho, como una celda del MPR 2x2, los textos de izquierda y
    // derecha se solaparian sin este recorte.
    var maxWidth = Math.max(40, (w - pad * 2 - 14) / 2);

    for (i = 0; i < this.overlay.topLeft.length; i++) {
      ctx.textAlign = 'left';
      ctx.fillText(elide(ctx, this.overlay.topLeft[i], maxWidth), pad, pad + i * lh);
    }
    for (i = 0; i < this.overlay.topRight.length; i++) {
      ctx.textAlign = 'right';
      ctx.fillText(elide(ctx, this.overlay.topRight[i], maxWidth), w - pad, pad + i * lh);
    }
    ctx.textBaseline = 'bottom';
    for (i = 0; i < this.overlay.bottomLeft.length; i++) {
      ctx.textAlign = 'left';
      var blIndex = this.overlay.bottomLeft.length - 1 - i;
      ctx.fillText(elide(ctx, this.overlay.bottomLeft[blIndex], maxWidth), pad, h - pad - i * lh);
    }
    for (i = 0; i < this.overlay.bottomRight.length; i++) {
      ctx.textAlign = 'right';
      var brIndex = this.overlay.bottomRight.length - 1 - i;
      ctx.fillText(elide(ctx, this.overlay.bottomRight[brIndex], maxWidth), w - pad, h - pad - i * lh);
    }

    if (this.orientationLabels) {
      ctx.fillStyle = '#8fa3bd';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      if (this.orientationLabels.left) ctx.fillText(this.orientationLabels.left, pad, h / 2);
      ctx.textAlign = 'right';
      if (this.orientationLabels.right) ctx.fillText(this.orientationLabels.right, w - pad, h / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      if (this.orientationLabels.top) ctx.fillText(this.orientationLabels.top, w / 2, pad);
      ctx.textBaseline = 'bottom';
      if (this.orientationLabels.bottom) ctx.fillText(this.orientationLabels.bottom, w / 2, h - pad);
    }

    this.drawScaleBar(ctx, w, h, t);
    ctx.restore();
  };

  /** Regla de escala, solo si el espaciado es real. */
  Viewport.prototype.drawScaleBar = function (ctx, w, h, t) {
    if (!this.image || this.image.hasRealSpacing === false) return;
    var pxPerMM = t.scale;
    if (!isFinite(pxPerMM) || pxPerMM <= 0) return;

    // Se elige una longitud "redonda" que ocupe entre 40 y 140 px.
    var candidates = [1, 2, 5, 10, 20, 50, 100, 200, 500];
    var chosen = null;
    for (var i = 0; i < candidates.length; i++) {
      var px = candidates[i] * pxPerMM;
      if (px >= 40 && px <= 140) { chosen = candidates[i]; break; }
      if (px > 140) break;
    }
    if (!chosen) return;

    var length = chosen * pxPerMM;
    var x = w - 12 - length;
    var y = h - 34;
    ctx.strokeStyle = '#c9d4e2';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + length, y);
    ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4);
    ctx.moveTo(x + length, y - 4); ctx.lineTo(x + length, y + 4);
    ctx.stroke();
    ctx.fillStyle = '#c9d4e2';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(chosen >= 10 ? (chosen / 10) + ' cm' : chosen + ' mm', x + length / 2, y - 5);
  };

  // ---------------------------------------------------------- Interaccion

  function localPoint(viewport, event) {
    var rect = viewport.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /**
   * Recorta un texto para que quepa en `maxWidth`, anadiendo puntos
   * suspensivos. Busqueda binaria sobre la longitud: medir caracter a
   * caracter se nota cuando hay cuatro paneles repintando.
   */
  function elide(ctx, text, maxWidth) {
    if (!text || ctx.measureText(text).width <= maxWidth) return text;
    var low = 0;
    var high = text.length;
    while (low < high) {
      var mid = (low + high + 1) >> 1;
      if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) low = mid;
      else high = mid - 1;
    }
    return low > 0 ? text.slice(0, low) + '…' : '';
  }

  /** Angulo del cursor alrededor del punto de referencia, en pantalla. */
  function referenceAngle(viewport, display) {
    if (!viewport.reference) return 0;
    var center = viewport.toDisplay(viewport.reference.point);
    return Math.atan2(display.y - center.y, display.x - center.x);
  }

  function bindEvents(viewport) {
    var canvas = viewport.canvas;

    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    canvas.addEventListener('pointerdown', function (event) {
      canvas.focus();
      if (!viewport.active && viewport.on.activate) viewport.on.activate();
      if (!viewport.image) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);

      var display = localPoint(viewport, event);
      var imagePoint = viewport.toImage(display);
      var action = { mode: null };

      if (event.button === 1 || (event.button === 0 && viewport.tool === 'pan')) {
        action.mode = 'pan';
      } else if (event.button === 2) {
        action.mode = 'window';
      } else if (event.button === 0) {
        if (viewport.tool === 'zoom') {
          action.mode = 'zoom';
        } else if (viewport.tool === 'wwwl') {
          action.mode = 'window';
        } else if (viewport.tool === 'crosshair') {
          action.mode = 'crosshair';
          if (viewport.on.crosshair) viewport.on.crosshair(imagePoint);
        } else if (viewport.tool === 'rotate') {
          action.mode = viewport.reference ? 'rotate' : null;
        } else if (DCM.tools.isAnnotationTool(viewport.tool)) {
          action = handleAnnotationDown(viewport, imagePoint);
        }
      }

      viewport._pointer = {
        mode: action.mode,
        handleIndex: action.handleIndex,
        startDisplay: display,
        lastDisplay: display,
        startImage: imagePoint,
        lastImage: imagePoint,
        lastAngle: action.mode === 'rotate' ? referenceAngle(viewport, display) : 0,
        button: event.button
      };
      viewport.render();
    });

    canvas.addEventListener('pointermove', function (event) {
      if (!viewport.image) return;
      var display = localPoint(viewport, event);
      var imagePoint = viewport.toImage(display);
      var pointer = viewport._pointer;

      if (viewport.on.cursor) {
        var inside = imagePoint.x >= 0 && imagePoint.y >= 0 &&
                     imagePoint.x < viewport.image.columns && imagePoint.y < viewport.image.rows;
        viewport.on.cursor(inside ? imagePoint : null,
          inside ? DCM.image.valueAt(viewport.image, imagePoint.x, imagePoint.y) : NaN);
      }

      if (!pointer || !pointer.mode) {
        // Un angulo a medio poner sigue al raton entre el segundo y el
        // tercer clic, sin boton pulsado.
        if (viewport._draft && !viewport._draft.complete) {
          DCM.tools.drag(viewport._draft, imagePoint);
          DCM.tools.measure(viewport._draft, viewport.image);
          viewport.render();
        }
        updateCursorStyle(viewport, imagePoint);
        return;
      }

      var dx = display.x - pointer.lastDisplay.x;
      var dy = display.y - pointer.lastDisplay.y;

      switch (pointer.mode) {
        case 'pan':
          viewport.panX += dx;
          viewport.panY += dy;
          if (viewport.on.view) viewport.on.view();
          break;
        case 'window':
          // Horizontal cambia el ancho, vertical el centro. El paso se
          // escala con el ancho actual para que sea usable tanto en ventanas
          // de 40 como de 4000.
          var step = Math.max(1, viewport.ww / 200);
          viewport.ww = Math.max(1, viewport.ww + dx * step);
          viewport.wc = viewport.wc - dy * step;
          if (viewport.on.window) viewport.on.window(viewport.ww, viewport.wc);
          break;
        case 'zoom':
          var factor = Math.exp(-dy / 150);
          viewport.zoom = Math.max(0.05, Math.min(60, viewport.zoom * factor));
          if (viewport.on.view) viewport.on.view();
          break;
        case 'crosshair':
          if (viewport.on.crosshair) viewport.on.crosshair(imagePoint);
          break;
        case 'rotate':
          var angle = referenceAngle(viewport, display);
          var swept = angle - pointer.lastAngle;
          // Se normaliza a (-pi, pi] para que cruzar el origen de atan2 no
          // produzca un salto de una vuelta entera.
          while (swept > Math.PI) swept -= Math.PI * 2;
          while (swept < -Math.PI) swept += Math.PI * 2;
          pointer.lastAngle = angle;
          if (viewport.on.rotate) viewport.on.rotate(swept);
          break;
        case 'create':
          DCM.tools.drag(viewport._draft, imagePoint);
          DCM.tools.measure(viewport._draft, viewport.image);
          break;
        case 'move-handle':
          viewport._selected.points[pointer.handleIndex] = imagePoint;
          DCM.tools.measure(viewport._selected, viewport.image);
          break;
        case 'move-body':
          DCM.tools.translate(viewport._selected,
            imagePoint.x - pointer.lastImage.x, imagePoint.y - pointer.lastImage.y);
          DCM.tools.measure(viewport._selected, viewport.image);
          break;
      }

      pointer.lastDisplay = display;
      pointer.lastImage = imagePoint;
      viewport.render();
    });

    canvas.addEventListener('pointerup', function (event) {
      var pointer = viewport._pointer;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      if (!pointer) return;
      viewport._pointer = null;

      if (pointer.mode === 'create' && viewport._draft) {
        var display = localPoint(viewport, event);
        var imagePoint = viewport.toImage(display);
        var complete = DCM.tools.commitPoint(viewport._draft, imagePoint);
        if (complete) {
          if (DCM.tools.isDegenerate(viewport._draft)) {
            viewport._draft = null;
          } else {
            DCM.tools.measure(viewport._draft, viewport.image);
            viewport.annotations.push(viewport._draft);
            viewport._selected = viewport._draft;
            viewport._draft = null;
            if (viewport.on.annotations) viewport.on.annotations(viewport.annotations);
          }
        }
        // Si no esta completa (angulo a medio poner) el borrador sigue vivo
        // y el siguiente clic lo termina.
      } else if (pointer.mode === 'move-handle' || pointer.mode === 'move-body') {
        if (viewport.on.annotations) viewport.on.annotations(viewport.annotations);
      }
      viewport.render();
    });

    canvas.addEventListener('pointercancel', function () {
      viewport._pointer = null;
    });

    canvas.addEventListener('wheel', function (event) {
      if (!viewport.image) return;
      event.preventDefault();
      if (!viewport.active && viewport.on.activate) viewport.on.activate();

      if (event.ctrlKey || event.metaKey) {
        var before = viewport.toImage(localPoint(viewport, event));
        var factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        viewport.zoom = Math.max(0.05, Math.min(60, viewport.zoom * factor));
        // Zoom hacia el cursor: se corrige el pan para que el punto bajo el
        // raton no se mueva.
        var after = viewport.toImage(localPoint(viewport, event));
        var t = viewport.transform();
        viewport.panX += (after.x - before.x) * t.sx;
        viewport.panY += (after.y - before.y) * t.sy;
        viewport.render();
        if (viewport.on.view) viewport.on.view();
      } else if (viewport.on.scroll) {
        viewport.on.scroll(event.deltaY > 0 ? 1 : -1);
      }
    }, { passive: false });

    canvas.addEventListener('dblclick', function (event) {
      event.preventDefault();
      viewport.reset();
    });
  }

  function handleAnnotationDown(viewport, imagePoint) {
    var tolerance = 8 / Math.max(0.01, viewport.transform().sx);

    // Un angulo a medio construir se completa con el siguiente clic.
    if (viewport._draft) {
      var done = DCM.tools.commitPoint(viewport._draft, imagePoint);
      if (done) {
        DCM.tools.measure(viewport._draft, viewport.image);
        if (!DCM.tools.isDegenerate(viewport._draft)) {
          viewport.annotations.push(viewport._draft);
          viewport._selected = viewport._draft;
          if (viewport.on.annotations) viewport.on.annotations(viewport.annotations);
        }
        viewport._draft = null;
        return { mode: null };
      }
      return { mode: 'create' };
    }

    // Editar una anotacion existente tiene prioridad sobre crear otra.
    for (var i = viewport.annotations.length - 1; i >= 0; i--) {
      var hit = DCM.tools.hitTest(viewport.annotations[i], imagePoint, tolerance);
      if (hit) {
        viewport._selected = viewport.annotations[i];
        return hit.kind === 'handle'
          ? { mode: 'move-handle', handleIndex: hit.index }
          : { mode: 'move-body' };
      }
    }

    viewport._selected = null;
    viewport._draft = DCM.tools.create(viewport.tool, imagePoint);
    DCM.tools.measure(viewport._draft, viewport.image);
    if (viewport._draft.complete && viewport._draft.type === 'probe') {
      viewport.annotations.push(viewport._draft);
      viewport._selected = viewport._draft;
      viewport._draft = null;
      if (viewport.on.annotations) viewport.on.annotations(viewport.annotations);
      return { mode: null };
    }
    return { mode: 'create' };
  }

  function updateCursorStyle(viewport, imagePoint) {
    var cursor = 'default';
    if (viewport.tool === 'pan') cursor = 'grab';
    else if (viewport.tool === 'zoom') cursor = 'zoom-in';
    else if (viewport.tool === 'wwwl') cursor = 'ns-resize';
    else if (viewport.tool === 'crosshair') cursor = 'crosshair';
    else if (viewport.tool === 'rotate') cursor = 'alias';
    else if (DCM.tools.isAnnotationTool(viewport.tool)) {
      cursor = 'crosshair';
      var tolerance = 8 / Math.max(0.01, viewport.transform().sx);
      for (var i = 0; i < viewport.annotations.length; i++) {
        var hit = DCM.tools.hitTest(viewport.annotations[i], imagePoint, tolerance);
        if (hit) { cursor = hit.kind === 'handle' ? 'pointer' : 'move'; break; }
      }
    }
    viewport.canvas.style.cursor = cursor;
  }

  /** Borra la anotacion seleccionada. Devuelve true si borro algo. */
  Viewport.prototype.deleteSelected = function () {
    if (!this._selected) return false;
    var index = this.annotations.indexOf(this._selected);
    if (index >= 0) this.annotations.splice(index, 1);
    this._selected = null;
    if (this.on.annotations) this.on.annotations(this.annotations);
    this.render();
    return true;
  };

  Viewport.prototype.cancelDraft = function () {
    if (!this._draft) return false;
    this._draft = null;
    this.render();
    return true;
  };

  DCM.Viewport = Viewport;
})(window);
