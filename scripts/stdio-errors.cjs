'use strict';

// A desktop-launched test can outlive the shell that was reading its output.
// Keep that closed pipe from reaching Electron's uncaught-exception dialog;
// unrelated stream errors must still fail the test.
function installOutputErrorHandlers(streams = [process.stdout, process.stderr]) {
  const outputs = [...new Set(streams)];
  const onError = error => {
    if (error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED') return;
    throw error;
  };
  for (const output of outputs) output.on('error', onError);
  return () => { for (const output of outputs) output.removeListener('error', onError); };
}

module.exports = { installOutputErrorHandlers };
