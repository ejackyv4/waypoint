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
