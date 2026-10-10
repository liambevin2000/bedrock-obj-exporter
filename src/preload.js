'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Streamed job events and a job's final reply travel separately, so the reply can arrive before the
// last events. The reply therefore says how many events were sent, and the job only completes once
// every one of them has been delivered - otherwise the tail of a preview's geometry would be lost.
const jobs = new Map(); // jobId -> { onEvent, received, expected, done }
let nextJob = 1;
ipcRenderer.on('job-event', (e, jobId, ev) => {
  const j = jobs.get(jobId);
  if (!j) return;
  j.received++;
  try { j.onEvent(ev); } finally { if (j.done && j.received >= j.expected) j.done(); }
});

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, args) => ipcRenderer.invoke(channel, args),
  // Long-running job on the worker; onEvent receives streamed progress / geometry.
  job: async (cmd, args, onEvent) => {
    const jobId = nextJob++;
    const j = { onEvent: onEvent || (() => {}), received: 0, expected: 0, done: null };
    jobs.set(jobId, j);
    try {
      const reply = await ipcRenderer.invoke('job', { cmd, args, jobId });
      j.expected = reply.events;
      if (j.received < j.expected) {
        await new Promise((resolve) => { j.done = resolve; setTimeout(resolve, 15000); }); // never hang on a lost event
      }
      return reply.result;
    } finally { jobs.delete(jobId); }
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  onUpdateState: (fn) => ipcRenderer.on('update-state', (e, state) => fn(state)),
});
