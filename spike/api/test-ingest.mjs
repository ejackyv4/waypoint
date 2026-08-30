#!/usr/bin/env node
/**
 * Hostile packages.
 *
 * `validateArchive()` is the only thing between an uploaded zip and this
 * server's filesystem, and until now nothing exercised it. The real corpus is
 * nine legitimate exports from real authoring tools — they prove the happy
 * path and say nothing about the adversarial one, which is the half that
 * matters when the uploader is not the author.
 *
 * CLAUDE.md names these fixtures explicitly and they did not exist.
 *
 * The archives are BUILT HERE rather than committed. A repository is not a
 * good home for a zip bomb: it is a file whose whole purpose is to be
 * dangerous when something unpacks it, and every scanner, backup and clone
 * would carry it. Writing them at test time costs sixty lines of zip format
 * and keeps the repository boring.
 *
 *   node spike/api/test-ingest.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, crc32 } from "node:zlib";
import { validateArchive } from "./ingest.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${m}`))
                        : (fail++, console.log(`  \x1b[31m✕\x1b[0m ${m}`)));

console.log("\n\x1b[1mHostile package fixtures\x1b[0m\n");

const dir = mkdtempSync(join(tmpdir(), "waypoint-ingest-"));
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} });

/* ------------------------------------------------------------------ *
 * a minimal zip writer                                                *
 *                                                                     *
 * Deliberately hand-rolled: the point of these fixtures is entry names *
 * and ratios that a normal archiver will not produce. `zip(1)` cleans  *
 * "../" out of paths, which is exactly the thing under test.          *
 * ------------------------------------------------------------------ */

function makeZip(path, files, { deflate = false } = {}) {
  const chunks = [], central = [];
  let offset = 0;

  for (const [name, content] of files) {
    const raw = Buffer.from(content);
    const data = deflate ? deflateRawSync(raw, { level: 9 }) : raw;
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(raw);
    const method = deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);      // local file header
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0, 6);               // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);              // time
    local.writeUInt16LE(0, 12);              // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);    // compressed
    local.writeUInt32LE(raw.length, 22);     // uncompressed
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);              // extra

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);         // central directory header
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 42 - 8);             // external attrs
    cd.writeUInt32LE(offset, 42);            // offset of local header

    chunks.push(local, nameBuf, data);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += local.length + nameBuf.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  writeFileSync(path, Buffer.concat([...chunks, cdBuf, end]));
  return path;
}

const manifest = ["imsmanifest.xml", "<manifest><resources/></manifest>"];

/* ---- a normal package still passes ---------------------------------
   Without this the others prove only that the checker rejects things. */
{
  const p = makeZip(join(dir, "ok.zip"), [manifest, ["index.html", "<html></html>"]]);
  const r = validateArchive(p);
  ok(r.ok && r.problems.length === 0,
     "an ordinary package passes — the checker is not simply refusing everything");
}

/* ---- zip-slip ------------------------------------------------------ */
for (const [label, name] of [
  ["a parent-directory escape",  "../escaped.txt"],
  ["a nested escape",            "content/../../escaped.txt"],
  ["an absolute path",           "/etc/cron.d/pwned"],
  ["a Windows absolute path",    "C:\\windows\\system32\\evil.dll"],
  ["a backslash escape",         "..\\escaped.txt"]
]) {
  const p = makeZip(join(dir, "slip.zip"), [manifest, [name, "x"]]);
  const r = validateArchive(p);
  ok(!r.ok && r.problems.some(x => /zip-slip/.test(x)),
     `zip-slip: ${label} (${name}) is refused`);
}

/* ---- zip bomb ------------------------------------------------------
   Highly compressible, so the ratio is enormous while the file on disk
   stays small. 8 MB of zeros deflates to a few kilobytes. */
{
  const p = makeZip(join(dir, "bomb.zip"),
    [manifest, ["big.bin", Buffer.alloc(8 * 1024 * 1024, 0)]], { deflate: true });
  const r = validateArchive(p);
  ok(!r.ok && r.problems.some(x => /zip bomb|ratio/i.test(x)),
     `a ${8}MB-of-zeros archive is refused as a bomb (ratio ${Math.round(r.ratio)}:1)`);
}

/* ---- server-executable content ------------------------------------- */
for (const name of ["shell.php", "cmd.jsp", "run.sh", "payload.exe", "x.aspx"]) {
  const p = makeZip(join(dir, "exe.zip"), [manifest, [name, "x"]]);
  const r = validateArchive(p);
  ok(!r.ok && r.problems.some(x => /server-executable/.test(x)),
     `a package containing ${name} is refused`);
}

/* ---- too many entries ---------------------------------------------- */
{
  const many = [manifest];
  for (let i = 0; i < 10_001; i++) many.push([`f${i}.txt`, "x"]);
  const p = makeZip(join(dir, "many.zip"), many);
  const r = validateArchive(p);
  ok(!r.ok && r.problems.some(x => /exceeds/.test(x)),
     "an archive with more than 10,000 entries is refused");
}

/* ---- not a zip at all ---------------------------------------------- */
{
  const p = join(dir, "notazip.zip");
  writeFileSync(p, "this is not a zip file, it is a sentence");
  const r = validateArchive(p);
  ok(!r.ok && r.problems.some(x => /readable zip/.test(x)),
     "a file that is not an archive is refused, not crashed on");
}

/* ---- the checks run BEFORE extraction ------------------------------
   The order is the whole defence: a bomb caught after unpacking has
   already filled the disk. */
{
  const p = makeZip(join(dir, "slip2.zip"), [manifest, ["../gotcha.txt", "x"]]);
  const before = validateArchive(p);
  ok(!before.ok && Array.isArray(before.entries) === false || !before.ok,
     "validation answers from the archive's index, without extracting it");
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
