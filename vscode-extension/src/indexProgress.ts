export interface IndexProgress {
  /** Human-readable message for the progress notification. */
  message: string;
  /** Completion ratio when the runtime reported one. */
  percent?: number;
}

const ANSI = /\[[0-9;]*[A-Za-z]/g;

/**
 * Read progress out of the indexer's console output.
 *
 * The runtime prints its own progress, but the extension previously discarded
 * every chunk until the process exited, leaving a static spinner with no
 * indication of whether a large repository needed ten seconds or ten minutes.
 * The patterns below are deliberately loose: an unrecognised line simply yields
 * no update rather than a wrong one.
 */
export function parseIndexProgress(chunk: string): IndexProgress | undefined {
  const lines = chunk
    .replace(ANSI, '')
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines.reverse()) {
    // "123/4560 files" or "Indexed 123 of 4560 files"
    const ratio = line.match(/(\d[\d,]*)\s*(?:\/|of)\s*(\d[\d,]*)\s*(files?|symbols?)?/i);
    if (ratio) {
      const done = Number(ratio[1]?.replaceAll(',', ''));
      const total = Number(ratio[2]?.replaceAll(',', ''));
      if (Number.isFinite(done) && Number.isFinite(total) && total > 0 && done <= total) {
        const unit = ratio[3] ? ratio[3].toLowerCase().replace(/s$/, '') : 'file';
        return {
          message: `${done.toLocaleString()} of ${total.toLocaleString()} ${unit}s indexed`,
          percent: Math.min(100, Math.round((done / total) * 100)),
        };
      }
    }
    // "45%" anywhere in the line
    const percent = line.match(/(\d{1,3})\s*%/);
    if (percent) {
      const value = Number(percent[1]);
      if (Number.isFinite(value) && value >= 0 && value <= 100) {
        return { message: line.slice(0, 120), percent: value };
      }
    }
    // A plain phase line such as "Resolving references…"
    if (/^(indexing|parsing|resolving|extracting|scanning|writing|discovering)\b/i.test(line)) {
      return { message: line.slice(0, 120) };
    }
  }
  return undefined;
}
