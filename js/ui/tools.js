/*
 * Mediciones y anotaciones.
 *
 * Las anotaciones se guardan en coordenadas de imagen (columna, fila) con
 * decimales, no en pixeles de pantalla, para que sobrevivan al zoom, al pan
 * y al cambio de tamano de la ventana.
 *
 * Las magnitudes se calculan con el espaciado real del plano: en las vistas
 * reconstruidas rowSpacing es el espaciado entre cortes, asi que una regla
 * en coronal mide milimetros de verdad igual que en axial.
 */
(function (global) {
  'use strict';

  var DCM = global.DCM = global.DCM || {};

  var TYPES = {
    probe: { label: 'Punto', points: 1 },
    length: { label: 'Regla', points: 2 },
    angle: { label: 'Angulo', points: 3 },
    rect: { label: 'ROI rectangular', points: 2 },
    ellipse: { label: 'ROI eliptica', points: 2 }
  };

  var nextId = 1;

  function formatNumber(value, decimals) {
    if (!isFinite(value)) return '--';
    return value.toFixed(decimals === undefined ? 1 : decimals);
  }

  var tools = DCM.tools = {
    types: TYPES,

    isAnnotationTool: function (type) {
      return !!TYPES[type];
    },

    create: function (type, point) {
      var needed = TYPES[type].points;
      var points = [];
      for (var i = 0; i < needed; i++) points.push({ x: point.x, y: point.y });
      return {
        id: nextId++,
        type: type,
        points: points,
        // Cuantos puntos ha fijado ya el usuario. El angulo necesita dos
        // clics, el resto se crean arrastrando.
        placed: 1,
        complete: needed === 1,
        stats: null,
        text: []
      };
    },

    /**
     * Mueve el punto que se esta colocando. `placed` cuenta los puntos ya
     * fijados, asi que el que sigue al raton es siempre points[placed].
     */
    drag: function (annotation, point) {
      var needed = TYPES[annotation.type].points;
      if (annotation.placed >= needed) return;
      annotation.points[annotation.placed] = { x: point.x, y: point.y };
    },

    /**
     * Fija el punto en construccion. Devuelve true cuando la anotacion queda
     * completa. El angulo es el unico tipo que encadena dos clics.
     */
    commitPoint: function (annotation, point) {
      var needed = TYPES[annotation.type].points;
      if (annotation.placed < needed) {
        annotation.points[annotation.placed] = { x: point.x, y: point.y };
        annotation.placed++;
      }
      annotation.complete = annotation.placed >= needed;
      return annotation.complete;
    },

    /** Descarta anotaciones degeneradas (clic sin arrastrar). */
    isDegenerate: function (annotation) {
      if (annotation.type === 'probe') return false;
      var p = annotation.points;
      if (annotation.type === 'angle') {
        return dist(p[0], p[1]) < 1 || dist(p[1], p[2]) < 1;
      }
      return dist(p[0], p[p.length - 1]) < 1;
    },

    hitTest: function (annotation, point, tolerance) {
      for (var i = 0; i < annotation.points.length; i++) {
        if (dist(annotation.points[i], point) <= tolerance) {
          return { kind: 'handle', index: i };
        }
      }
      if (annotation.type === 'rect' || annotation.type === 'ellipse') {
        var box = bounds(annotation);
        if (point.x >= box.x0 - tolerance && point.x <= box.x1 + tolerance &&
            point.y >= box.y0 - tolerance && point.y <= box.y1 + tolerance) {
          return { kind: 'body' };
        }
      } else {
        for (var s = 0; s < annotation.points.length - 1; s++) {
          if (distanceToSegment(point, annotation.points[s], annotation.points[s + 1]) <= tolerance) {
            return { kind: 'body' };
          }
        }
      }
      return null;
    },

    translate: function (annotation, dx, dy) {
      annotation.points.forEach(function (p) { p.x += dx; p.y += dy; });
    },

    /**
     * Recalcula magnitudes y el texto que se muestra junto a la anotacion.
     */
    measure: function (annotation, image) {
      var sx = image.colSpacing || 1;
      var sy = image.rowSpacing || 1;
      var real = image.hasRealSpacing !== false;
      var unit = real ? 'mm' : 'px';
      var ux = real ? sx : 1;
      var uy = real ? sy : 1;
      var p = annotation.points;
      var text = [];
      annotation.stats = null;

      if (annotation.type === 'probe') {
        var value = DCM.image.valueAt(image, p[0].x, p[0].y);
        text.push(isNaN(value)
          ? 'fuera de imagen'
          : formatNumber(value, 1) + (image.unit ? ' ' + image.unit : ''));
      } else if (annotation.type === 'length') {
        var dx = (p[1].x - p[0].x) * ux;
        var dy = (p[1].y - p[0].y) * uy;
        text.push(formatNumber(Math.sqrt(dx * dx + dy * dy), 2) + ' ' + unit);
      } else if (annotation.type === 'angle') {
        var v1 = { x: (p[0].x - p[1].x) * ux, y: (p[0].y - p[1].y) * uy };
        var v2 = { x: (p[2].x - p[1].x) * ux, y: (p[2].y - p[1].y) * uy };
        var n1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
        var n2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);
        if (n1 > 0 && n2 > 0) {
          var cos = (v1.x * v2.x + v1.y * v2.y) / (n1 * n2);
          cos = Math.max(-1, Math.min(1, cos));
          text.push(formatNumber(Math.acos(cos) * 180 / Math.PI, 1) + ' °');
        }
      } else {
        var stats = regionStats(annotation, image);
        annotation.stats = stats;
        if (stats) {
          var areaUnit = real ? 'mm²' : 'px';
          text.push('Area ' + formatNumber(stats.area, 1) + ' ' + areaUnit);
          if (stats.count > 0) {
            var suffix = image.unit ? ' ' + image.unit : '';
            text.push('Media ' + formatNumber(stats.mean, 1) + suffix);
            text.push('DE ' + formatNumber(stats.sd, 1));
            text.push('Min ' + formatNumber(stats.min, 0) + ' / Max ' + formatNumber(stats.max, 0));
            text.push(stats.count + ' px');
          }
        }
      }

      annotation.text = text;
      return annotation;
    },

    /** Dibuja la anotacion. `toDisplay(point)` convierte a pixeles CSS. */
    draw: function (ctx, annotation, toDisplay, style) {
      var color = style.color;
      var p = annotation.points.map(toDisplay);

      ctx.save();
      ctx.lineWidth = style.lineWidth || 1.5;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.font = style.font;
      ctx.lineJoin = 'round';

      if (annotation.type === 'probe') {
        crossMark(ctx, p[0], 6);
      } else if (annotation.type === 'length') {
        ctx.beginPath();
        ctx.moveTo(p[0].x, p[0].y);
        ctx.lineTo(p[1].x, p[1].y);
        ctx.stroke();
        endCap(ctx, p[0], p[1]);
        endCap(ctx, p[1], p[0]);
      } else if (annotation.type === 'angle') {
        ctx.beginPath();
        ctx.moveTo(p[0].x, p[0].y);
        ctx.lineTo(p[1].x, p[1].y);
        ctx.lineTo(p[2].x, p[2].y);
        ctx.stroke();
        arc(ctx, p[1], p[0], p[2]);
      } else if (annotation.type === 'rect') {
        ctx.beginPath();
        ctx.rect(Math.min(p[0].x, p[1].x), Math.min(p[0].y, p[1].y),
                 Math.abs(p[1].x - p[0].x), Math.abs(p[1].y - p[0].y));
        ctx.stroke();
      } else if (annotation.type === 'ellipse') {
        var cx = (p[0].x + p[1].x) / 2;
        var cy = (p[0].y + p[1].y) / 2;
        var rx = Math.abs(p[1].x - p[0].x) / 2;
        var ry = Math.abs(p[1].y - p[0].y) / 2;
        ctx.beginPath();
        ctx.ellipse(cx, cy, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (style.showHandles) {
        for (var i = 0; i < p.length; i++) {
          ctx.beginPath();
          ctx.arc(p[i].x, p[i].y, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = style.handleColor || color;
          ctx.fill();
        }
      }

      if (annotation.text && annotation.text.length) {
        drawLabel(ctx, annotation, p, style);
      }

      ctx.restore();
    }
  };

  function drawLabel(ctx, annotation, p, style) {
    // La etiqueta se ancla al punto mas a la derecha para no tapar el trazo.
    var anchor = p.reduce(function (best, point) {
      return point.x > best.x ? point : best;
    }, p[0]);
    var lines = annotation.text;
    var lineHeight = style.lineHeight || 14;
    var padding = 4;
    var widths = lines.map(function (line) { return ctx.measureText(line).width; });
    var boxWidth = Math.max.apply(null, widths) + padding * 2;
    var boxHeight = lines.length * lineHeight + padding * 2 - 2;

    var x = anchor.x + 10;
    var y = anchor.y - boxHeight / 2;
    var canvas = ctx.canvas;
    var maxX = canvas.clientWidth || canvas.width;
    var maxY = canvas.clientHeight || canvas.height;
    if (x + boxWidth > maxX - 4) x = anchor.x - 10 - boxWidth;
    if (x < 4) x = 4;
    if (y < 4) y = 4;
    if (y + boxHeight > maxY - 4) y = maxY - 4 - boxHeight;

    ctx.fillStyle = 'rgba(8, 12, 18, 0.72)';
    ctx.beginPath();
    ctx.rect(x, y, boxWidth, boxHeight);
    ctx.fill();
    ctx.strokeStyle = style.color;
    ctx.globalAlpha = 0.35;
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = style.textColor || style.color;
    ctx.textBaseline = 'top';
    for (var i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x + padding, y + padding + i * lineHeight);
    }
  }

  function crossMark(ctx, point, size) {
    ctx.beginPath();
    ctx.moveTo(point.x - size, point.y);
    ctx.lineTo(point.x + size, point.y);
    ctx.moveTo(point.x, point.y - size);
    ctx.lineTo(point.x, point.y + size);
    ctx.stroke();
  }

  function endCap(ctx, from, to) {
    // Marca perpendicular en el extremo de la regla.
    var dx = to.x - from.x;
    var dy = to.y - from.y;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = -dy / len * 5;
    var ny = dx / len * 5;
    ctx.beginPath();
    ctx.moveTo(from.x - nx, from.y - ny);
    ctx.lineTo(from.x + nx, from.y + ny);
    ctx.stroke();
  }

  function arc(ctx, vertex, a, b) {
    var r = Math.min(24, dist(vertex, a) * 0.4, dist(vertex, b) * 0.4);
    if (r < 6) return;
    var a1 = Math.atan2(a.y - vertex.y, a.x - vertex.x);
    var a2 = Math.atan2(b.y - vertex.y, b.x - vertex.x);
    var delta = a2 - a1;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    ctx.beginPath();
    ctx.arc(vertex.x, vertex.y, r, a1, a1 + delta, delta < 0);
    ctx.globalAlpha = 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function dist(a, b) {
    return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
  }

  function distanceToSegment(p, a, b) {
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) return dist(p, a);
    var t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
  }

  function bounds(annotation) {
    var p = annotation.points;
    return {
      x0: Math.min(p[0].x, p[1].x),
      y0: Math.min(p[0].y, p[1].y),
      x1: Math.max(p[0].x, p[1].x),
      y1: Math.max(p[0].y, p[1].y)
    };
  }

  /** Estadisticas de un ROI en unidades de modalidad. */
  function regionStats(annotation, image) {
    if (image.samplesPerPixel !== 1) return null;
    var box = bounds(annotation);
    var real = image.hasRealSpacing !== false;
    var sx = real ? (image.colSpacing || 1) : 1;
    var sy = real ? (image.rowSpacing || 1) : 1;

    var x0 = Math.max(0, Math.floor(box.x0));
    var y0 = Math.max(0, Math.floor(box.y0));
    var x1 = Math.min(image.columns - 1, Math.ceil(box.x1));
    var y1 = Math.min(image.rows - 1, Math.ceil(box.y1));

    var isEllipse = annotation.type === 'ellipse';
    var cx = (box.x0 + box.x1) / 2;
    var cy = (box.y0 + box.y1) / 2;
    var rx = (box.x1 - box.x0) / 2;
    var ry = (box.y1 - box.y0) / 2;

    var count = 0, sum = 0, sumSq = 0;
    var min = Infinity, max = -Infinity;
    var slope = image.slope, intercept = image.intercept;
    var pixels = image.pixels;

    for (var y = y0; y <= y1; y++) {
      var rowOffset = y * image.columns;
      for (var x = x0; x <= x1; x++) {
        if (isEllipse) {
          if (rx <= 0 || ry <= 0) continue;
          var nx = (x + 0.5 - cx) / rx;
          var ny = (y + 0.5 - cy) / ry;
          if (nx * nx + ny * ny > 1) continue;
        }
        var value = pixels[rowOffset + x] * slope + intercept;
        count++;
        sum += value;
        sumSq += value * value;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }

    // El area se calcula sobre la geometria, no contando pixeles: es mas
    // estable cuando el ROI es pequeno.
    var widthMM = (box.x1 - box.x0) * sx;
    var heightMM = (box.y1 - box.y0) * sy;
    var area = isEllipse
      ? Math.PI * (widthMM / 2) * (heightMM / 2)
      : widthMM * heightMM;

    if (!count) {
      return { area: area, count: 0, mean: NaN, sd: NaN, min: NaN, max: NaN };
    }
    var mean = sum / count;
    var variance = Math.max(0, sumSq / count - mean * mean);
    return {
      area: area,
      count: count,
      mean: mean,
      sd: Math.sqrt(variance),
      min: min,
      max: max
    };
  }
})(window);
