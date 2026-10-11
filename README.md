# Lector DICOM

Visor DICOM que funciona abriendo `index.html` en el navegador. Sin instalación,
sin servidor, sin dependencias externas: el parser, el renderizador y la
reconstrucción multiplanar están escritos en el propio proyecto.

Los ficheros se leen con la File API del navegador y **nunca salen del equipo**.

> Herramienta de visualización y desarrollo. No es un producto sanitario ni está
> validado para uso diagnóstico.

## Uso

Abre `index.html` con doble clic. Luego:

- **Abrir carpeta** para cargar un estudio completo, o arrastra la carpeta sobre la ventana.
- **Fantoma** genera un estudio TC sintético para probar sin datos reales.

Si el navegador pone pegas con `file://`, sirve la carpeta por HTTP:

```powershell
powershell -ExecutionPolicy Bypass -File "serve.ps1"
```

y abre <http://127.0.0.1:8731/>. El script usa solo .NET del sistema, no hace
falta Node ni Python.

## Qué hace

**Visor.** Agrupa por estudio y serie, ordena los cortes por posición real
(`ImagePositionPatient` proyectado sobre la normal del plano, con
`InstanceNumber` como respaldo), navega con rueda, teclado, slider o cine.

**Ventana y nivel.** Botón derecho para ajustar, o presets radiológicos
(pulmón, mediastino, abdomen, hígado, hueso, cerebro, fosa posterior, ictus,
angio, columna). La función VOI es la LINEAR de la norma (PS3.3 C.11.2.1.2),
aplicada con una LUT indexada por *stored value*.

**Mediciones.** Regla, ángulo, ROI rectangular y elíptica con media, desviación
y mínimo/máximo en unidades de modalidad, y valor puntual. Las anotaciones se
guardan en coordenadas de imagen, así que sobreviven al zoom y al pan, y se
pueden reeditar arrastrando sus puntos.

**MPR, incluido oblicuo.** Con una serie de cortes paralelos se habilitan
coronal, sagital y un MIP de slab configurable, con líneas de referencia
sincronizadas entre paneles. Cada plano lleva su espaciado real, de modo que
una regla en coronal mide milímetros de verdad aunque el espaciado entre
cortes no sea el mismo que el del píxel.

Con la herramienta **Girar** se arrastra dentro de un panel para reorientar la
reconstrucción; **Ortogonal** vuelve a los planos nativos. Ver más abajo cómo
está montado.

**Metadatos.** Volcado completo de la cabecera, incluidas secuencias anidadas,
con filtro por nombre, tag o valor.

## Cómo funciona la reconstrucción oblicua

Los tres planos salen de un único marco ortonormal en coordenadas de paciente
(LPS). Al cargar una serie coincide con los ejes del volumen, así que las
vistas son las nativas; girarlo las vuelve oblicuas. El estado de navegación es
un punto en milímetros, no un índice de corte, que es lo que permite que
posición y orientación sean independientes de la rejilla original.

Hay un detalle de diseño que vale la pena conocer porque determina cómo se
siente la herramienta: **la base de pantalla de cada vista no son los ejes del
marco**, sino que se deriva de la normal del plano más una referencia anatómica
fija (posterior para la axial, caudal para las otras dos). Por eso, al girar
dentro de un panel, ese panel no se mueve —es el mismo plano, solo rota sobre
sí mismo— y lo que giran son sus líneas de referencia y el contenido de los
otros dos paneles. Es el comportamiento que se espera al reorientar un corte, y
sale solo de esa elección de base en lugar de necesitar casos especiales.

Mientras un plano siga coincidiendo con uno nativo se muestran **los píxeles
originales, sin interpolar**. Solo se remuestrea cuando de verdad hace falta, y
entonces la vista lo indica con `remuestreado` y el ángulo de oblicuidad. Un
giro alrededor de la normal de la axial, por ejemplo, deja la axial intacta y
solo oblicúa coronal y sagital.

El remuestreo es trilineal. Como el mapeo de paciente a vóxel es afín, los
incrementos se precalculan y el bucle interno son tres sumas por píxel: un
plano de 256×256 tarda unos 4 ms y un MIP de 20 mm sobre ese plano unos 40 ms,
de sobra para arrastrar en tiempo real.

Verificado contra el fantoma: remuestrear con la base nativa reproduce el corte
original en los 65.536 píxeles sin una sola diferencia; girar 90° sobre la
normal axial hace que el plano coronal caiga exactamente sobre el sagital
nativo; y el valor bajo la cruz es el mismo en cualquier orientación, que es lo
que confirma que los tres planos pasan por el mismo punto del espacio.

Las mediciones se indexan por plano, orientación y posición. Al reorientar, las
de la orientación anterior dejan de mostrarse y reaparecen si se vuelve a ella;
no se borra ninguna, y al pulsar una en la lista se recupera exactamente el
plano en que se tomó.

## Formatos

Se leen sin nada más:

| Transfer syntax | |
|---|---|
| `1.2.840.10008.1.2` | Implicit VR Little Endian |
| `1.2.840.10008.1.2.1` | Explicit VR Little Endian |
| `1.2.840.10008.1.2.1.99` | Deflated (se infla con `DecompressionStream`) |
| `1.2.840.10008.1.2.2` | Explicit VR Big Endian |
| `1.2.840.10008.1.2.5` | RLE Lossless |
| `1.2.840.10008.1.2.4.50/51` | JPEG baseline y extended, vía el decoder del navegador |

También se aceptan ficheros sin preámbulo Part 10 y se recupera de elementos
codificados como implícitos dentro de datasets explícitos, que es el fallo más
común de los exportadores antiguos.

**Aviso sobre JPEG.** El decoder del navegador devuelve 8 bits por muestra, así
que para imágenes de más profundidad los valores no son fieles al original. La
aplicación lo marca en pantalla con `! valores aproximados`. No midas
Hounsfield sobre una imagen marcada así.

### Lo que falta

JPEG Lossless (`.57`, `.70`), JPEG-LS (`.80`, `.81`), JPEG 2000 (`.90`, `.91`)
y HTJ2K (`.201`–`.203`) necesitan un codec que no trae el navegador. El fichero
se detecta y se avisa con el nombre del transfer syntax en vez de fallar en
silencio. El punto de extensión está preparado:

```js
DCM.decoders.register('1.2.840.10008.1.2.4.90', async (bytes, info) => {
  return { bytes: await miCodecJ2K(bytes) };  // píxeles ya descomprimidos
});
```

Otras limitaciones conocidas:

- No hay reformateo curvo (CPR), que es lo que haría falta para desplegar un
  vaso o la columna a lo largo de su trayecto.
- La reconstrucción asume cortes paralelos y equiespaciados; si el espaciado es
  irregular se reconstruye igualmente pero se avisa en pantalla, porque el
  volumen no es entonces una rejilla regular y el remuestreo interpola sobre
  una suposición que no se cumple.
- El volumen se muestrea desde los cortes originales, sin copiarlo a un buffer
  3D. Ahorra duplicar cientos de MB, pero significa que una serie que no quepa
  en memoria tampoco se podrá reconstruir.
- Los multiframe mejorados se leen, pero de los *functional groups* solo se
  aprovechan espaciado, posición, orientación y VOI.
- Sin soporte de overlays (grupo 60xx) ni de objetos de presentación (GSPS).
- Las mediciones no se exportan todavía a SR ni a ningún fichero.

## Estructura

```
index.html              Maquetación y orden de carga de los scripts
css/styles.css          Tema oscuro
js/dicom/dictionary.js  Tabla de tags (imprescindible para Implicit VR)
js/dicom/parser.js      Part 10, secuencias, pixel data encapsulado
js/dicom/decoders.js    Nativo, RLE, JPEG; registro de codecs externos
js/dicom/image.js       Stored values, modalidad, LUT y presentación
js/dicom/volume.js      Estudios/series, ordenación 3D, coordenadas de
                        paciente, MIP y remuestreo oblicuo
js/dicom/mpr.js         Marco de orientación, bases de vista, planos y pistas
js/ui/viewport.js       Canvas, transformaciones, ratón y overlays
js/ui/tools.js          Anotaciones, geometría y estadística de ROI
js/ui/app.js            Carga, paneles, sincronización y atajos
js/dev/phantom.js       Generador del estudio TC de prueba (prescindible)
serve.ps1               Servidor estático mínimo, solo para desarrollo
```

Todo son scripts clásicos sobre un único global `DCM`, sin módulos ES: es lo que
permite abrir el proyecto directamente desde `file://`, donde los módulos están
bloqueados por CORS.

## Atajos

| | |
|---|---|
| Rueda | Cambiar de corte |
| Ctrl + rueda | Zoom sobre el cursor |
| Botón derecho | Ventana / nivel |
| Botón central | Desplazar |
| Doble clic | Reencuadrar |
| ↑ ↓ / PgUp PgDn / Inicio Fin | Navegación de cortes |
| W P Z C G | Ventana, mover, zoom, cruz, girar |
| 1 2 3 4 5 | Punto, regla, ángulo, ROI rect, ROI elipse |
| I / R / O / Espacio | Invertir, reencuadrar, volver a ortogonal, cine |
| Supr / Esc | Borrar medición, cancelar la que está en curso |

## Licencia

Apache 2.0. Ver [LICENSE](LICENSE) y [NOTICE](NOTICE).

## Contribuir

Si abres una incidencia con un estudio que no se lee, **no adjuntes imágenes de
pacientes**: basta con el transfer syntax, el fabricante y el volcado de la
pestaña Avisos. El `.gitignore` bloquea `*.dcm` y similares por defecto para
que no se cuele un estudio real en un commit, pero conviene revisar
`git status` antes de confirmar.
