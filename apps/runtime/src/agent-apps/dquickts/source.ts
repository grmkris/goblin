/** Deliberately synchronous: dquickts cannot suspend host calls through async frames. */
export const durableSource = (code: string): string => `(function() {
  const logs = [];
  const log = (...parts) => { if (logs.length < 100) logs.push(parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ').slice(0, 500)); };
  const call = (name, args) => { const r = hostCall(name, args); if (!r.ok) throw new Error(r.error); return r.value; };
  const files = {
    read: path => call('files.read', {path}),
    list: dir => call('files.list', {dir}),
    write: (path, text) => call('files.write', {path, text})
  };
  const tools = { call: (connectionId, name, args) => call('tools.call', {connectionId, name, arguments: args}) };
  try {
    const value = (function() { ${code}\n })();
    if (value && typeof value.then === 'function') throw new Error('durable code requires synchronous TypeScript; do not use async or await');
    return {ok:true, value: value === undefined ? null : value, logs};
  } catch (e) { return {ok:false, error:String(e).slice(0, 4000), logs}; }
})()`
