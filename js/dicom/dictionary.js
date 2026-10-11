/*
 * Diccionario DICOM reducido.
 *
 * Solo contiene los tags que el lector necesita: identificacion, geometria,
 * y descriptores de imagen. El VR es imprescindible para poder leer datasets
 * en Implicit VR Little Endian, donde el fichero no lo transmite.
 *
 * VR "xs" = US o SS segun PixelRepresentation (0028,0103); se resuelve en
 * tiempo de lectura.
 */
(function (global) {
  'use strict';

  var DCM = global.DCM = global.DCM || {};

  // [tag, VR, nombre]
  var TABLE = [
    // --- File Meta Information (grupo 0002, siempre Explicit VR LE) ---
    ['00020000', 'UL', 'FileMetaInformationGroupLength'],
    ['00020001', 'OB', 'FileMetaInformationVersion'],
    ['00020002', 'UI', 'MediaStorageSOPClassUID'],
    ['00020003', 'UI', 'MediaStorageSOPInstanceUID'],
    ['00020010', 'UI', 'TransferSyntaxUID'],
    ['00020012', 'UI', 'ImplementationClassUID'],
    ['00020013', 'SH', 'ImplementationVersionName'],
    ['00020016', 'AE', 'SourceApplicationEntityTitle'],

    // --- Identificacion general ---
    ['00080005', 'CS', 'SpecificCharacterSet'],
    ['00080008', 'CS', 'ImageType'],
    ['00080012', 'DA', 'InstanceCreationDate'],
    ['00080013', 'TM', 'InstanceCreationTime'],
    ['00080016', 'UI', 'SOPClassUID'],
    ['00080018', 'UI', 'SOPInstanceUID'],
    ['00080020', 'DA', 'StudyDate'],
    ['00080021', 'DA', 'SeriesDate'],
    ['00080022', 'DA', 'AcquisitionDate'],
    ['00080023', 'DA', 'ContentDate'],
    ['00080030', 'TM', 'StudyTime'],
    ['00080031', 'TM', 'SeriesTime'],
    ['00080032', 'TM', 'AcquisitionTime'],
    ['00080033', 'TM', 'ContentTime'],
    ['00080050', 'SH', 'AccessionNumber'],
    ['00080060', 'CS', 'Modality'],
    ['00080070', 'LO', 'Manufacturer'],
    ['00080080', 'LO', 'InstitutionName'],
    ['00080090', 'PN', 'ReferringPhysicianName'],
    ['00081010', 'SH', 'StationName'],
    ['00081030', 'LO', 'StudyDescription'],
    ['0008103E', 'LO', 'SeriesDescription'],
    ['00081050', 'PN', 'PerformingPhysicianName'],
    ['00081090', 'LO', 'ManufacturerModelName'],

    // --- Paciente ---
    ['00100010', 'PN', 'PatientName'],
    ['00100020', 'LO', 'PatientID'],
    ['00100030', 'DA', 'PatientBirthDate'],
    ['00100040', 'CS', 'PatientSex'],
    ['00101010', 'AS', 'PatientAge'],
    ['00101020', 'DS', 'PatientSize'],
    ['00101030', 'DS', 'PatientWeight'],

    // --- Adquisicion ---
    ['00180015', 'CS', 'BodyPartExamined'],
    ['00180020', 'CS', 'ScanningSequence'],
    ['00180021', 'CS', 'SequenceVariant'],
    ['00180023', 'CS', 'MRAcquisitionType'],
    ['00180050', 'DS', 'SliceThickness'],
    ['00180060', 'DS', 'KVP'],
    ['00180080', 'DS', 'RepetitionTime'],
    ['00180081', 'DS', 'EchoTime'],
    ['00180087', 'DS', 'MagneticFieldStrength'],
    ['00180088', 'DS', 'SpacingBetweenSlices'],
    ['00180090', 'DS', 'DataCollectionDiameter'],
    ['00181030', 'LO', 'ProtocolName'],
    ['00181100', 'DS', 'ReconstructionDiameter'],
    ['00181110', 'DS', 'DistanceSourceToDetector'],
    ['00181120', 'DS', 'GantryDetectorTilt'],
    ['00181150', 'IS', 'ExposureTime'],
    ['00181151', 'IS', 'XRayTubeCurrent'],
    ['00181152', 'IS', 'Exposure'],
    ['00181160', 'SH', 'FilterType'],
    ['00181210', 'SH', 'ConvolutionKernel'],
    ['00181314', 'DS', 'FlipAngle'],
    ['00185100', 'CS', 'PatientPosition'],

    // --- Geometria / relacion ---
    ['0020000D', 'UI', 'StudyInstanceUID'],
    ['0020000E', 'UI', 'SeriesInstanceUID'],
    ['00200010', 'SH', 'StudyID'],
    ['00200011', 'IS', 'SeriesNumber'],
    ['00200012', 'IS', 'AcquisitionNumber'],
    ['00200013', 'IS', 'InstanceNumber'],
    ['00200020', 'CS', 'PatientOrientation'],
    ['00200032', 'DS', 'ImagePositionPatient'],
    ['00200037', 'DS', 'ImageOrientationPatient'],
    ['00200052', 'UI', 'FrameOfReferenceUID'],
    ['00200060', 'CS', 'Laterality'],
    ['00201040', 'LO', 'PositionReferenceIndicator'],
    ['00201041', 'DS', 'SliceLocation'],
    ['00204000', 'LT', 'ImageComments'],

    // --- Descriptores de imagen ---
    ['00280002', 'US', 'SamplesPerPixel'],
    ['00280004', 'CS', 'PhotometricInterpretation'],
    ['00280006', 'US', 'PlanarConfiguration'],
    ['00280008', 'IS', 'NumberOfFrames'],
    ['00280009', 'AT', 'FrameIncrementPointer'],
    ['00280010', 'US', 'Rows'],
    ['00280011', 'US', 'Columns'],
    ['00280030', 'DS', 'PixelSpacing'],
    ['00280034', 'IS', 'PixelAspectRatio'],
    ['00280100', 'US', 'BitsAllocated'],
    ['00280101', 'US', 'BitsStored'],
    ['00280102', 'US', 'HighBit'],
    ['00280103', 'US', 'PixelRepresentation'],
    ['00280106', 'xs', 'SmallestImagePixelValue'],
    ['00280107', 'xs', 'LargestImagePixelValue'],
    ['00280120', 'xs', 'PixelPaddingValue'],
    ['00281050', 'DS', 'WindowCenter'],
    ['00281051', 'DS', 'WindowWidth'],
    ['00281052', 'DS', 'RescaleIntercept'],
    ['00281053', 'DS', 'RescaleSlope'],
    ['00281054', 'LO', 'RescaleType'],
    ['00281055', 'LO', 'WindowCenterWidthExplanation'],
    ['00281101', 'xs', 'RedPaletteColorLookupTableDescriptor'],
    ['00281102', 'xs', 'GreenPaletteColorLookupTableDescriptor'],
    ['00281103', 'xs', 'BluePaletteColorLookupTableDescriptor'],
    ['00281201', 'OW', 'RedPaletteColorLookupTableData'],
    ['00281202', 'OW', 'GreenPaletteColorLookupTableData'],
    ['00281203', 'OW', 'BluePaletteColorLookupTableData'],
    ['00282110', 'CS', 'LossyImageCompression'],
    ['00282112', 'DS', 'LossyImageCompressionRatio'],
    ['00282114', 'CS', 'LossyImageCompressionMethod'],

    // --- Multiframe mejorado (se parsean como secuencias) ---
    ['52009229', 'SQ', 'SharedFunctionalGroupsSequence'],
    ['52009230', 'SQ', 'PerFrameFunctionalGroupsSequence'],
    ['00209113', 'SQ', 'PlanePositionSequence'],
    ['00209116', 'SQ', 'PlaneOrientationSequence'],
    ['00289110', 'SQ', 'PixelMeasuresSequence'],
    ['00289132', 'SQ', 'FrameVOILUTSequence'],
    ['00289145', 'SQ', 'PixelValueTransformationSequence'],

    // --- Datos de pixel ---
    ['7FE00008', 'OF', 'FloatPixelData'],
    ['7FE00009', 'OD', 'DoubleFloatPixelData'],
    ['7FE00010', 'OW', 'PixelData']
  ];

  var dictionary = Object.create(null);
  for (var i = 0; i < TABLE.length; i++) {
    dictionary[TABLE[i][0]] = { vr: TABLE[i][1], name: TABLE[i][2] };
  }

  DCM.dictionary = dictionary;

  /** Nombre legible del tag, o "(gggg,eeee)" si es desconocido/privado. */
  DCM.tagName = function (tag) {
    var entry = dictionary[tag];
    if (entry) return entry.name;
    var group = tag.slice(0, 4);
    // Los grupos impares son privados por definicion DICOM.
    var isPrivate = (parseInt(group, 16) & 1) === 1;
    return '(' + group + ',' + tag.slice(4) + ')' + (isPrivate ? ' privado' : '');
  };

  /** Atajo para construir la clave de 8 hex a partir de grupo y elemento. */
  DCM.tagKey = function (group, element) {
    return (group + 0x10000).toString(16).slice(1).toUpperCase() +
           (element + 0x10000).toString(16).slice(1).toUpperCase();
  };
})(window);
