import { readPeFile } from "../src/native/pe.ts";
const paths = process.argv.slice(2);
for (const path of paths) {
  const info = await readPeFile(path);
  console.log(`== ${path}\n   machine=0x${info.machine.toString(16)} is64=${info.is64} dll=${info.isDll} exports=${info.exports.length}`);
  const names = info.exports.map((e) => e.name + (e.forwarder ? ` -> ${e.forwarder}` : ""));
  const filter = process.env.FILTER;
  for (const n of names) if (!filter || n.includes(filter)) console.log("   " + n);
}
