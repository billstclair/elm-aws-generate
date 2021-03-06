const { lowCam, upCam, safeIdentifier } = require('./util');
const render = require('./render');

const jsonDecode = 'JD';
const jsonEncode = 'JE';

module.exports = (shapesWithoutNames, { inputShapes, outputShapes }) => {
  const shapes = {};
  Object.keys(shapesWithoutNames).forEach((rawName) => {
    const name = upCam(rawName);
    shapes[rawName] = Object.assign({ name }, shapesWithoutNames[rawName]);
  });

  const resolve = {};

  resolve.type = (sh) => {
    const typeResolver = resolve[sh.type];
    if (typeResolver) {
      return Object.assign({ name: sh.name }, typeResolver(sh));
    }
    throw new Error(`Could not find type resolver for ${JSON.stringify(sh)}`);
  };

  resolve.shape = sh =>
    resolve.type(shapes[sh.shape]);

  resolve.boolean = () => render.nothing({
    type: 'Bool',
    decoder: `${jsonDecode}.bool`,
    jsonEncoder: `${jsonEncode}.bool`,
    queryEncoderType: 'AWS.Core.Encode.bool',
    queryEncoder: base => `AWS.Core.Encode.addOneToQueryArgs AWS.Core.Encode.bool "${base}"`,
  });

  resolve.float = () => render.nothing({
    type: 'Float',
    decoder: `${jsonDecode}.float`,
    jsonEncoder: `${jsonEncode}.float`,
    queryEncoderType: 'toString',
    queryEncoder: base => `AWS.Core.Encode.addOneToQueryArgs toString "${base}"`,
  });

  resolve.double = resolve.float;

  resolve.integer = () => render.nothing({
    type: 'Int',
    decoder: `${jsonDecode}.int`,
    jsonEncoder: `${jsonEncode}.int`,
    queryEncoderType: 'toString',
    queryEncoder: base => `AWS.Core.Encode.addOneToQueryArgs toString "${base}"`,
  });

  resolve.long = resolve.integer;

  resolve.list = (sh) => {
    const child = resolve.shape(sh.member);
    return render.nothing({
      type: `(List ${child.type})`,
      decoder: `(${jsonDecode}.list ${child.decoder})`,
      jsonEncoder: `(List.map (${child.jsonEncoder})) >> ${jsonEncode}.list`,
      queryEncoderType: child.queryEncoderType,
      queryEncoder: base => `AWS.Core.Encode.addListToQueryArgs ${sh.flattened ? 'True' : 'False'} (${child.queryEncoder('')}) "${base}"`,
    });
  };

  const isEnumOf = pattern => key => (
    key.enum && key.enum.length &&
    key.enum.every(pattern.test.bind(pattern))
  );

  const isEnumOfFloats = isEnumOf(/\d+(\.\d+)/);

  resolve.map = (sh) => {
    const key = resolve.shape(sh.key);
    if (key.type !== 'String' && !key.enum) {
      throw new Error(`Unexpected map key type ${key.type}, don't know how to decode`);
    }
    const value = resolve.shape(sh.value);
    const queryEncoderType = isEnumOfFloats(key)
      ? 'AWS.Core.Enum.toFloat >> Result.withDefault 0.0 >> toString'
      : 'AWS.Core.Enum.toString >> Result.withDefault ""';
    const queryEncoder = base => `AWS.Core.Encode.addOneToQueryArgs (${queryEncoderType}) "${base}"`;

    return isEnumOfFloats(key) ?
      render.nothing({
        type: `(Dict Float ${value.type})`,
        decoder: `(JDX.dict2 ${jsonDecode}.float ${value.decoder})`,
        jsonEncoder: `AWS.Core.Enum.toFloat >> Result.withDefault 0.0 >> ${jsonEncode}.float`,
        queryEncoderType,
        queryEncoder,
        extraImports: [
          'import AWS.Core.Enum',
          'import Dict exposing (Dict)',
          'import Json.Decode.Extra as JDX',
        ],
      }) :
      render.nothing({
        type: `(Dict String ${value.type})`,
        decoder: `(AWS.Core.Decode.dict ${value.decoder})`,
        jsonEncoder: `AWS.Core.Enum.toString >> Result.withDefault "" >> ${jsonEncode}.string`,
        queryEncoderType,
        queryEncoder,
        extraImports: [
          'import AWS.Core.Enum',
          'import Dict exposing (Dict)',
        ],
      });
  };

  resolve.string = sh => (sh.enum
    ? resolve.enum(sh)
    : render.nothing({
      type: 'String',
      decoder: `${jsonDecode}.string`,
      jsonEncoder: `${jsonEncode}.string`,
      queryEncoderType: '(\\x -> x)',
      queryEncoder: base => `AWS.Core.Encode.addOneToQueryArgs (\\x -> x) "${base}"`,
    }));

  resolve.blob = resolve.string; // TODO:

  resolve.timestamp = () => render.nothing({
    type: 'Date',
    decoder: 'JDX.date',
    jsonEncoder: `Date.Extra.toUtcIsoString >> ${jsonEncode}.string`,
    queryEncoderType: 'Date.Extra.toUtcIsoString',
    queryEncoder: base => `AWS.Core.Encode.addOneToQueryArgs Date.Extra.toUtcIsoString "${base}"`,
    extraImports: [
      'import Date exposing (Date)',
      'import Date.Extra',
      'import Json.Decode.Extra as JDX',
    ],
  });

  resolve.enum = sh => render.enum({
    type: sh.name,
    decoder: `${lowCam(sh.name)}Decoder`,
    jsonEncoder: `AWS.Core.Enum.toString >> Result.withDefault "" >> ${jsonEncode}.string`,
    queryEncoderType: 'AWS.Core.Enum.toString >> Result.withDefault ""',
    queryEncoder: base => `AWS.Core.Encode.addOneToQueryArgs (AWS.Core.Enum.toString >> Result.withDefault "") "${base}"`,
    extraImports: [
      'import AWS.Core.Enum',
    ],
    enum: sh.enum.map(safeIdentifier),
    doc: render.enumDoc(sh),
    category: 'union',
  });

  resolve.structure = (sh) => {
    const category = resolve.structureCategory(sh);
    return render.structure({
      type: sh.name,
      decoder: `${lowCam(sh.name)}Decoder`,
      jsonEncoder: `${lowCam(sh.name)}Encoder`,
      queryEncoderType: `${lowCam(sh.name)}Encoder`,
      queryEncoder: base => `AWS.Core.Encode.addRecordToQueryArgs ${lowCam(sh.name)}Encoder "${base}"`,
      members: Object.keys(sh.members).map(key => ({
        required: sh.required && sh.required.indexOf(key) !== -1,
        key: safeIdentifier(lowCam(key)),
        rawKey: key,
        decodeKeys: Array.from(new Set([key, lowCam(key), upCam(key)])),
        value: resolve.shape(sh.members[key]),
      })),
      doc: category === 'response'
        ? `Type of HTTP response from ${lowCam(sh.name).slice(0, sh.name.length - 8)}`
        : sh.documentation,
      category,
    });
  };

  resolve.structureCategory = (sh) => {
    if (sh.exception) { return 'exception'; }
    if (outputShapes.indexOf(sh.name) !== -1) { return 'response'; }
    if (inputShapes.indexOf(sh.name) !== -1) { return 'request'; }
    return 'record';
  };

  const types = Object.keys(shapes).map(name =>
    resolve.type(Object.assign({ name }, shapes[name])));
  const byShape = {};
  types.forEach((t) => {
    byShape[t.type] = t;
  });
  types.findByShape = shape => byShape[shape];
  return types;
};
