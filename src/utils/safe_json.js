function stripProto(value) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = stripProto(value[i]);
    }
    return value;
  }
  if (value && typeof value === 'object' && value.constructor === Object) {
    const keys = Object.keys(value);
    for (const key of keys) {
      if (key === '__proto__' || key === 'constructor') {
        delete value[key];
      } else {
        value[key] = stripProto(value[key]);
      }
    }
  }
  return value;
}

export function safeJsonParse(text, reviver) {
  const parsed = JSON.parse(text, reviver);
  return stripProto(parsed);
}
