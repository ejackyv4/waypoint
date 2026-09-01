/**
 * Where generated documents live on disk.
 *
 * Its own module because two things need the path — the agreement module
 * writes PDFs into it, and the profile module serves them back out — and
 * neither owns it.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { CONTENT_DIR } from "../ingest.mjs";

export const DOCS_DIR = join(CONTENT_DIR, "..", "documents");
mkdirSync(DOCS_DIR, { recursive: true });

/* Photographs taken on a visit. Kept apart from generated documents: these are
   uploaded bytes from a phone camera, not something this system produced. */
export const PHOTOS_DIR = join(CONTENT_DIR, "..", "visit-photos");
mkdirSync(PHOTOS_DIR, { recursive: true });

export const AUDIO_DIR = join(CONTENT_DIR, "..", "visit-audio");
mkdirSync(AUDIO_DIR, { recursive: true });
