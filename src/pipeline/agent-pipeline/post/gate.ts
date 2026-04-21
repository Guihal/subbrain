/**
 * Gate for the post-processing extraction loop. Skip exchanges shorter than
 * MIN_EXTRACTION_LENGTH (combined user + assistant chars) — too little signal.
 */
import { MIN_EXTRACTION_LENGTH } from "../types";

export function shouldRunHippocampus(combinedLen: number): boolean {
  return combinedLen >= MIN_EXTRACTION_LENGTH;
}

export { MIN_EXTRACTION_LENGTH };
