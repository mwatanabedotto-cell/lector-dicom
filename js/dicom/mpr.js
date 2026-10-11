/*
 * Marco de reconstruccion multiplanar.
 *
 * Los tres planos (axial, coronal, sagital) se derivan de un unico marco
 * ortonormal `frame` expresado en coordenadas de paciente (LPS). Al arrancar
 * coincide con los ejes del volumen, de modo que las vistas son las nativas;
 * al rotarlo, los planos se vuelven oblicuos.
 *
 * Detalle importante del diseno: la base de pantalla de cada vista NO son los
 * ejes del marco, sino que se deriva de la normal del plano mas una referencia
 * anatomica fija (posterior para la axial, caudal para las otras dos). Gracias
 * a eso, girar el marco alrededor de la normal de una vista deja esa vista
 * quieta -es el mismo plano- y hace girar sus lineas de referencia, que es lo
 * que el usuario espera al reorientar un corte.
 *
 * Mientras un plano sigue coincidiendo con uno nativo se usan los cortes
 * originales sin remuestrear; solo se interpola cuando de verdad hace falta.
 */
(function (global) {
  'use strict';

  var DCM = global.DCM = global.DCM || {};
  var vec = null; // se resuelve al vuelo: volume.js define DCM.vec

  var PLANES = ['axial', 'coronal', 'sagittal'];

  var COLORS = {
    axial: '#7ee0ff',
    coronal: '#8ce89a',
    sagittal: '#ffb066'
  };

  // Referencias anatomicas para orientar la pantalla, en LPS:
  // +x izquierda del paciente, +y posterior, +z craneal.
  var POSTERIOR = [0, 1, 0];
  var INFERIOR = [0, 0, -1];
  var LEFT = [1, 0, 0];

  var EPS = 1e-4;

  function v() { return (vec || (vec = DCM.vec)); }

  function rotateAbout(value, axis, angle) {
    var V = v();
    var cos = Math.cos(angle), sin = Math.sin(angle);
    var kv = V.cross(axis, value);
    var kd = V.dot(axis, value) * (1 - cos);
    return [
      value[0] * cos + kv[0] * sin + axis[0] * kd,
      value[1] * cos + kv[1] * sin + axis[1] * kd,
      value[2] * cos + kv[2] * sin + axis[2] * kd
    ];
  }

  /** Reortonormaliza para que las rotaciones encadenadas no acumulen deriva. */
  function orthonormalize(frame) {
    var V = v();
    var x = V.normalize(frame.x);
    var y = V.normalize(V.sub(frame.y, V.scale(x, V.dot(frame.y, x))));
    var z = V.cross(x, y);
    return { x: x, y: y, z: z };
  }

  var mpr = DCM.mpr = {
    PLANES: PLANES,
    COLORS: COLORS,

    /** Marco inicial: los propios ejes del volumen. */
    createFrame: function (volume) {
      return { x: volume.axisI.slice(), y: volume.axisJ.slice(), z: volume.axisK.slice() };
    },

    rotateFrame: function (frame, axis, angle) {
      return orthonormalize({
        x: rotateAbout(frame.x, axis, angle),
        y: rotateAbout(frame.y, axis, angle),
        z: rotateAbout(frame.z, axis, angle)
      });
    },

    /**
     * Normal del plano, orientada de forma que cross(right, down) la reproduce
     * con la convencion de pantalla habitual de cada vista.
     */
    planeNormal: function (frame, plane) {
      if (plane === 'coronal') return frame.y;
      if (plane === 'sagittal') return v().scale(frame.x, -1);
      return frame.z; // axial y MIP axial
    },

    /**
     * Base de pantalla de una vista: {normal, right, down}.
     * `down` se obtiene proyectando la referencia anatomica sobre el plano,
     * asi que no depende de como este girado el marco dentro de ese plano.
     */
    viewBasis: function (frame, plane) {
      var V = v();
      var normal = V.normalize(mpr.planeNormal(frame, plane));
      var preferred = plane === 'axial' || plane === 'mip' ? POSTERIOR : INFERIOR;

      var down = V.sub(preferred, V.scale(normal, V.dot(preferred, normal)));
      if (V.norm(down) < 1e-3) {
        // El plano es casi perpendicular a la referencia; se usa otra para no
        // dividir por cero (pasa con un sagital girado 90 grados, por ejemplo).
        var alternate = plane === 'axial' || plane === 'mip' ? LEFT : POSTERIOR;
        down = V.sub(alternate, V.scale(normal, V.dot(alternate, normal)));
      }
      down = V.normalize(down);
      return { normal: normal, right: V.cross(down, normal), down: down };
    },

    /**
     * Si la base coincide con una de las vistas nativas del volumen devuelve
     * su nombre; si no, null. Solo entonces se pueden usar los pixeles
     * originales en vez de remuestrear.
     */
    nativeMatch: function (volume, basis) {
      var V = v();
      var aligned = function (a, b) { return V.dot(a, b) > 1 - 1e-6; };
      var down = basis.down, right = basis.right, normal = basis.normal;
      var minusK = V.scale(volume.axisK, -1);

      if (aligned(normal, volume.axisK) && aligned(down, volume.axisJ) &&
          aligned(right, volume.axisI)) {
        return 'axial';
      }
      // Los cortes coronal y sagital rapidos se generan apilando de arriba
      // abajo; si el volumen esta apilado al reves, se remuestrea.
      if (volume.flipZ) return null;
      if (aligned(normal, volume.axisJ) && aligned(down, minusK) &&
          aligned(right, volume.axisI)) {
        return 'coronal';
      }
      if (aligned(normal, V.scale(volume.axisI, -1)) && aligned(down, minusK) &&
          aligned(right, volume.axisJ)) {
        return 'sagittal';
      }
      return null;
    },

    /** Angulo en grados entre el plano actual y el nativo equivalente. */
    obliquity: function (volume, plane, basis) {
      var V = v();
      var reference = plane === 'coronal' ? volume.axisJ
        : (plane === 'sagittal' ? V.scale(volume.axisI, -1) : volume.axisK);
      var cos = Math.abs(V.dot(basis.normal, reference));
      return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
    },

    /** Centro por defecto: el del volumen, en milimetros de paciente. */
    defaultCenter: function (volume) {
      return DCM.toPatient(volume,
        (volume.columns - 1) / 2, (volume.rows - 1) / 2, (volume.depth - 1) / 2);
    },

    /**
     * Lineas de interseccion de los otros dos planos con esta vista.
     * Todas pasan por el centro, asi que basta con su direccion en pantalla.
     */
    referenceLines: function (frame, plane) {
      var V = v();
      var basis = mpr.viewBasis(frame, plane);
      var self = plane === 'mip' ? 'axial' : plane;
      var lines = [];

      PLANES.forEach(function (other) {
        if (other === self) return;
        var otherNormal = V.normalize(mpr.planeNormal(frame, other));
        var direction = V.cross(basis.normal, otherNormal);
        if (V.norm(direction) < 1e-6) return;
        direction = V.normalize(direction);
        lines.push({
          plane: other,
          color: COLORS[other],
          dx: V.dot(direction, basis.right),
          dy: V.dot(direction, basis.down)
        });
      });

      return lines;
    },

    /**
     * Imagen de una vista. Devuelve tambien donde cae el centro dentro de
     * ella, porque en modo nativo depende del indice y en oblicuo siempre
     * queda en el medio.
     */
    view: function (volume, frame, center, plane, options) {
      options = options || {};
      var basis = mpr.viewBasis(frame, plane);
      var native = mpr.nativeMatch(volume, basis);
      var voxel = DCM.toVoxel(volume, center);
      var slab = options.slab || 0;
      var wantsSlab = plane === 'mip' && slab > 0;

      if (native) {
        var fast = nativeView(volume, native, voxel, plane, slab, wantsSlab);
        if (fast) {
          fast.basis = basis;
          fast.native = native;
          fast.obliquity = 0;
          fast.mapToPatient = nativeMapper(volume, native, voxel);
          return fast;
        }
      }

      var size = planeSize(volume, basis, center);
      var key = obliqueKey(basis, center, size, slab, options.interpolate);
      var cached = volume._oblique && volume._oblique[plane];
      var image;
      if (cached && cached.key === key) {
        image = cached.image;
      } else {
        image = DCM.sampleOblique(volume, {
          center: center,
          right: basis.right,
          down: basis.down,
          width: size.width,
          height: size.height,
          spacing: size.spacing,
          slab: wantsSlab ? slab : 0,
          slabMode: options.slabMode || 'max',
          interpolate: options.interpolate !== false,
          // El hecho de ser oblicuo ya se indica en la cabecera de la vista;
          // aqui solo se etiqueta lo que anade informacion.
          label: wantsSlab ? 'MIP oblicuo ' + Math.round(slab) + ' mm' : ''
        });
        if (!volume._oblique) volume._oblique = Object.create(null);
        volume._oblique[plane] = { key: key, image: image };
      }

      var cross = { x: (size.width - 1) / 2, y: (size.height - 1) / 2 };
      return {
        image: image,
        cross: cross,
        basis: basis,
        native: null,
        obliquity: mpr.obliquity(volume, plane === 'mip' ? 'axial' : plane, basis),
        mapToPatient: function (x, y) {
          var V = v();
          return V.add(center, V.add(
            V.scale(basis.right, (x - cross.x) * size.spacing),
            V.scale(basis.down, (y - cross.y) * size.spacing)
          ));
        }
      };
    },

    /**
     * Recorrido del centro a lo largo de la normal de una vista: cuantos pasos
     * caben dentro del volumen y en cual esta ahora. Sirve para el slider,
     * que asi funciona igual en nativo y en oblicuo.
     */
    track: function (volume, basis, center) {
      var V = v();
      // En una vista nativa el paso es el espaciado real de esa direccion, de
      // forma que cada muesca de la rueda cae exactamente en un corte.
      var native = mpr.nativeMatch(volume, basis);
      var step = native === 'axial' ? volume.spacingK
        : native === 'coronal' ? volume.spacingJ
          : native === 'sagittal' ? volume.spacingI
            : volume.sampleSpacing;
      var extent = DCM.extentAlong(volume, basis.normal);
      var position = V.dot(center, basis.normal);
      var count = Math.max(1, Math.round(extent.length / step) + 1);
      var index = Math.round((position - extent.min) / step);
      return {
        count: count,
        index: Math.max(0, Math.min(count - 1, index)),
        step: step,
        min: extent.min,
        /** Centro desplazado al paso `target`, conservando la posicion en el plano. */
        at: function (target) {
          var clamped = Math.max(0, Math.min(count - 1, target));
          var delta = (extent.min + clamped * step) - position;
          return V.add(center, V.scale(basis.normal, delta));
        }
      };
    }
  };

  // --------------------------------------------------------------- Internos

  /** Vistas nativas: se devuelven los cortes originales, sin interpolar. */
  function nativeView(volume, native, voxel, plane, slab, wantsSlab) {
    var k = Math.max(0, Math.min(volume.depth - 1, Math.round(voxel.k)));
    var i = Math.max(0, Math.min(volume.columns - 1, Math.round(voxel.i)));
    var j = Math.max(0, Math.min(volume.rows - 1, Math.round(voxel.j)));

    if (native === 'axial') {
      if (wantsSlab) {
        return {
          image: DCM.axialMIP(volume, k, slab),
          cross: { x: voxel.i, y: voxel.j }
        };
      }
      return { image: DCM.axialSlice(volume, k), cross: { x: voxel.i, y: voxel.j } };
    }
    if (plane === 'mip') return null; // el MIP solo tiene camino rapido en axial
    if (native === 'coronal') {
      return {
        image: DCM.coronalSlice(volume, j),
        cross: { x: voxel.i, y: DCM.sliceForRow(volume, k) }
      };
    }
    return {
      image: DCM.sagittalSlice(volume, i),
      cross: { x: voxel.j, y: DCM.sliceForRow(volume, k) }
    };
  }

  /**
   * Convierte coordenadas de la imagen nativa a milimetros de paciente.
   * `sliceForRow` es involutiva, asi que sirve igual para ir y volver entre
   * fila de pantalla e indice de corte.
   */
  function nativeMapper(volume, native, voxel) {
    var k = Math.max(0, Math.min(volume.depth - 1, Math.round(voxel.k)));
    var i = Math.max(0, Math.min(volume.columns - 1, Math.round(voxel.i)));
    var j = Math.max(0, Math.min(volume.rows - 1, Math.round(voxel.j)));

    if (native === 'axial') {
      return function (x, y) { return DCM.toPatient(volume, x, y, k); };
    }
    if (native === 'coronal') {
      return function (x, y) {
        return DCM.toPatient(volume, x, j, DCM.sliceForRow(volume, y));
      };
    }
    return function (x, y) {
      return DCM.toPatient(volume, i, x, DCM.sliceForRow(volume, y));
    };
  }

  /**
   * Tamano de salida de un plano oblicuo: simetrico respecto al centro y
   * suficiente para cubrir el volumen entero desde esa orientacion.
   */
  function planeSize(volume, basis, center) {
    var V = v();
    var spacing = volume.sampleSpacing;
    var halfRight = 0, halfDown = 0;

    for (var corner = 0; corner < 8; corner++) {
      var p = DCM.toPatient(volume,
        (corner & 1) ? volume.columns - 1 : 0,
        (corner & 2) ? volume.rows - 1 : 0,
        (corner & 4) ? volume.depth - 1 : 0);
      var d = V.sub(p, center);
      halfRight = Math.max(halfRight, Math.abs(V.dot(d, basis.right)));
      halfDown = Math.max(halfDown, Math.abs(V.dot(d, basis.down)));
    }

    // Tope para no generar matrices gigantes si el centro se aleja mucho.
    var width = Math.min(900, 2 * Math.ceil(halfRight / spacing) + 1);
    var height = Math.min(900, 2 * Math.ceil(halfDown / spacing) + 1);
    return { width: width, height: height, spacing: spacing };
  }

  function round(value, decimals) {
    var factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
  }

  function obliqueKey(basis, center, size, slab, interpolate) {
    return [
      basis.normal.map(function (c) { return round(c, 5); }).join(','),
      basis.right.map(function (c) { return round(c, 5); }).join(','),
      center.map(function (c) { return round(c, 3); }).join(','),
      size.width, size.height, round(size.spacing, 4), round(slab || 0, 2),
      interpolate === false ? 'n' : 't'
    ].join('|');
  }
})(window);
