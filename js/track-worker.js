// Pitch tracking off the main thread, so the page stays smooth while a long take
// is analysed. Messages: { id, samples, sr } in; { id, progress } and then
// { id, track } (or { id, error }) out.
import { extractTrack } from './pitch.js';

self.onmessage = async ({ data: { id, samples, sr } }) => {
  try {
    const track = await extractTrack(samples, sr, (progress) => self.postMessage({ id, progress }));
    self.postMessage({ id, track });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};
