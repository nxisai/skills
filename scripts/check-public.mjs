#!/usr/bin/env node
/**
 * Fails when something that ships names what isn't public: a private repository, an issue or
 * pull request reference, an internal host, environment or document, or an email address.
 *
 *   node scripts/check-public.mjs <file|dir|.tar.gz>...
 *
 * Run on the repository's tree: the skills, their references and the README are what
 * `npx skills add` installs and what the public repository shows.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * What may not appear, and why. The public repositories are these skills, the agent harness and
 * the CLI; an npm package name (@nxisai/…) is public too.
 */
export const RULES = [
  { why: "a private repository", re: /(?<!@)\bnxisai\/(?!(?:agent-harness|cli|skills)(?![\w-]))[A-Za-z0-9_.-]+/g },
  { why: "an issue or pull request reference", re: /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+\b/g },
  {
    // Not a CSS color: #0000, \`color: #333\`, \`light-dark(#eee, #111)\`. No issue is numbered 0.
    why: "a bare issue or pull request number",
    re: /(?<=^|[\s(\[])(?<!:\s*|\b(?:light-dark|rgba?|hsla?|color-mix|(?:linear|radial|conic)-gradient|var|drop-shadow)\([^()\n]*)#(?!0+\b)\d{1,5}\b(?![\w-])/gm,
  },
  {
    // Not Docker's own names for the host machine, which local-development steps use.
    why: "an internal host",
    re: /(?<![A-Za-z0-9.-])(?!(?:host|gateway)\.docker\.internal\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:internal|corp|lan)\b(?!\.md\b)/g,
  },
  {
    why: "a cloud or tunnel host",
    re: /\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:run\.app|cloud\.goog|appspot\.com|cloudfunctions\.net|mongodb\.net|ngrok(?:-free)?\.(?:io|app|dev))\b/g,
  },
  { why: "a database connection string", re: /\bmongodb(?:\+srv)?:\/\/[^\s"'`]+/g },
  // A named internal document; the bare glob in .gitignore names none.
  { why: "an internal document", re: /\b[A-Za-z0-9_-]+\.internal\.md\b/g },
  {
    // Not in license texts, where upstream authors' addresses belong.
    why: "an email address",
    skip: /(?:^|\/)(?:LICENSE|NOTICE|THIRD_PARTY)[^/]*$/,
    re: /\b[A-Za-z0-9._%+-]+@(?!(?:[A-Za-z0-9-]+\.)*(?:example\.(?:com|org|net)|example|test|invalid|localhost)\b|users\.noreply\.github\.com\b|github\.com\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/gi,
  },
];

/**
 * Names that are not public and may not appear anywhere, as the sha256 of each one lowercased,
 * so this file doesn't publish the names it keeps out: internal environments and documents,
 * private repositories without their owner, internal services and infrastructure, hosts, project
 * ids and ports. Terraform is not one here: the hosting guides deploy with it.
 * Add one with `printf %s name | shasum -a 256`.
 */
export const HIDDEN = new Set([
  "2f888ba84be4aa8e9b7270f74156320b639a1a39dc642c0b638489c0cd099810",
  "67d6db37e657c2993b0018a4d8f44b27db319500a6203a90fc82e52b0af00acf",
  "053536d6771cbd989f326253d223ecb50645363181e8af5e6c64e868bf886a43",
  "0c4dace95a063db6234b0b6ff89b09e99a48fde4af095d6b74dc5da2b2e19556",
  "2add43b3115f16113ecd01268fa77b38eb5963564aee1d999b1f93213748f8e1",
  "c6a9c9d1d6d092ae4350e23842f34192d135abe83fe048f91ed40b0f249efc93",
  "1244bfa4854898416e18ba98346801f0c6b41524d12f211157f956c796cc70de",
  "0191fb9a9f9d320ad800efafb987c291b2ad6c2dab956bc4d803169ce0e3fb86",
  "3f9ed0136de2e93684be9f3a7b83de86da304a92d691c0805dad4f3484fe0f6e",
  "1822aa606516eee6a4f792c3c080b58a29952db452f7d1ed25b7950260a245ec",
  "39839fa609ba8694745dac3078585eb53f35a787e5cd83e810e4cd2cca98e78e",
  "0fc4fc3bdc36f1ca2832f258e220fa9c90ff9f5b606aa7a5f57f51ac5df915df",
  "9450c7cfdba1ab42b4d51a24cf538d70733663be6281f12c564d3558421278a6",
  "164ce42c5ceeb468ff407d376f571260b9bd890b49ee9dfc943841b590452543",
  "c715ed753056520430e0567950707a67215e09a3ac92922ac7bccf904570757a",
  "549cbd964a6cbb2b53bfd39a87df18a7761793b296c7b9c463a8723a77e3431a",
  "d8e1e4758c268e4e38ac4966964e896b14ac80dff624220b929583cb2c861389",
  "509f7c7ca47e9d41e4ed006204fa871a2a0ef3f3b73551265a83dc2ee7d9b478",
  "ef0ad5d72b42b088a8b655be68122d494dcf7d648467ef8071e8166a1e9c45eb",
  "cc899763ae7ea30a84740649ac689825ea4cffdaec27d5ad836e90afebb173a1",
  "0c1442d64d37d7ea417dd230cb6474e0041a0b0dc88d2bb613b5bf4f8986998b",
  "5989d8d8ca5914ac605d353610adae836dace554b964e336d0f133fe46f75ae8",
  "75eb66809549d77df1f8a019aa03fff87d77457a772eae8c1686370fe6ef34a9",
  "f2e83447da46b3ecb67ea8204d2c5ad895fd94f6ab373d11a9b59647b5529add",
  "f1e0a3ac92e40f33576db905ab0a0a295324aeaf7778f2b643099b3629db97bc",
  "a2129c4f723f781f6479b7134c74790da20ed8eab48cccd3c079561bf5d1bea2",
  "28620bf462fc056fe40914744840eb9b7b099e0510cead0bc51d149867619d70",
  "e972ae59f8a6f4ba42707bd474d346ca050c4f2d8b3e1b6fb0b6c9c837a33994",
  "604a54f37d986eb4b05937c791a4e3c43daace8df88e73d2c6ecb2e7077e8790",
  "614ebf3588f6c1a0a4360a3dd04089ebf9818a5363107033259352c8c3ffee06",
  "ae49e2818511e71b42d250112176740328612986e0a41ee9d7b947a4ded87402",
  "6205b95b0cc23228f805a7dfda105355ef625fcaca7b87fa3f93cda0a4f63f0f",
  "2af7fb32aa889c4ee9bcc01e06ec54f9a8b1c06b4b623e49f48c7dc3353a2e41",
  "6fa005f5ff9ae54e8690842b0bcbf22a8fba711a1beb25e98cecd8d517195736",
  "d78a42cf95744fe2ca657110ab8f096b2fb9aba4e4bbcf9226dab717bf75125d",
  "dffd46510013c284d0899c12fceafdf249d60a42c63f5dd170eb06ff52465807",
  "d0d3ef25fa7433573bda594a970973dbde7cf02d670ae12e26bc91aa9954d0c7",
  "f61ba53d22d168944722382ff4797bc670f30d2aa80699e798bfdf9453c3ecf7",
  "6a8b2e075f49fa3eeb79bd790f4112a3c5c4dae8e1330c3d889a74033209d39b",
  "912d434e65541c899d1bc57ff14ec8a7d46bca8c24307b51d1ef1f7977b77653",
  "7d15e14fc226c42ae9e464c3420ab58eb064928d7db153c91db76d3dedbba842",
  "bb46047e4456e978bfd84109e6012dc90ba4df4ed7ba04fee3c72954f9f8c9e4",
  "897ae4a2d6829265e30ee905ec4a54b0823cf86e26f9e73fbcdde58e8c7c2f14",
  "4f816901a495838542f60ccc05c197d026e1b7bfb67c2aef51ab1d48130f2644",
  "8464289476168ddfc98ae6901663bfba37c1e99c84cdd838f0de4ff7952268d7",
  "5a474ed0e1451e66b5371c8299cab03f1d7a3549a24102252a0ba07afdbb4dda",
  "d2a0d6d2356542ee2cf581736105ee26c3de1f58249c7d3853953a77a4ce56f9",
]);

/** Files never scanned: none yet. */
const SKIP = [];

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/**
 * @param hidden The hashed names to look for (HIDDEN unless given).
 * @param file The text's path, for the rules that don't apply to some files.
 * @returns Every problem in one text, as `line: text (why)`.
 */
export function findInternal(text, hidden = HIDDEN, file = "") {
  const found = [];
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    // Each word, and each of its dotted parts, so `name.md` and `host.example` are caught too.
    for (const m of line.matchAll(/[A-Za-z0-9_.-]+/g)) {
      const word = m[0].replace(/^[.-]+|[.-]+$/g, "");
      for (const part of new Set([word, ...word.split(".")])) {
        if (part && hidden.has(sha256(part.toLowerCase()))) found.push({ line: i + 1, match: part, why: "an internal name" });
      }
    }
  }
  for (const { why, re, skip } of RULES) {
    if (skip?.test(file)) continue;
    for (const [i, line] of lines.entries()) {
      for (const m of line.matchAll(new RegExp(re.source, re.flags.replace("m", "")))) {
        found.push({ line: i + 1, match: m[0], why });
      }
    }
  }
  return found;
}

/**
 * A skill's `icon` is a Heroicons (v2, outline) name in kebab case, such as `rocket-launch`, which the
 * host draws as an SVG in its own colors; never an emoji, which renders differently everywhere.
 *
 * @returns The problem with a SKILL.md's `icon`, as findInternal reports one; none for other files.
 */
export function findBadIcon(text, file = "") {
  if (!/(?:^|\/)SKILL\.md$/.test(file)) return [];
  const front = text.match(/^---\n([\s\S]*?)\n---/);
  if (!front) return [];
  const lines = front[1].split("\n");
  const i = lines.findIndex((l) => /^icon:/.test(l));
  if (i < 0) return [{ line: 1, match: "icon", why: "no icon: give a Heroicons name, such as rocket-launch" }];
  const value = lines[i].slice("icon:".length).trim().replace(/^(["'])(.*)\1$/, "$2");
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return [];
  return [{ line: i + 2, match: value, why: "an icon that isn't a Heroicons name, such as rocket-launch" }];
}

function* files(path) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const f of readdirSync(path).sort()) {
      if (f === "node_modules" || f === ".git") continue;
      yield* files(join(path, f));
    }
  } else if (st.isFile()) {
    yield path;
  }
}

/** @returns The problems in every path given, tarballs unpacked. */
export function checkPaths(paths) {
  const problems = [];
  for (const given of paths) {
    let root = given;
    let tmp;
    if (/\.(tar\.gz|tgz)$/.test(given)) {
      tmp = mkdtempSync(join(tmpdir(), "nxis-check-public-"));
      execFileSync("tar", ["-xzf", given, "-C", tmp]);
      root = tmp;
    }
    try {
      for (const file of files(root)) {
        const rel = relative(root, file) || file;
        if (SKIP.some((s) => s.test(rel))) continue;
        const bytes = readFileSync(file);
        if (bytes.includes(0)) continue; // binary
        const text = bytes.toString("utf8");
        for (const p of [...findInternal(text, HIDDEN, rel), ...findBadIcon(text, rel)]) {
          problems.push(`${tmp ? `${given}:` : ""}${tmp ? rel : file}:${p.line}: ${p.match} (${p.why})`);
        }
      }
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("usage: node scripts/check-public.mjs <file|dir|.tar.gz>...");
    process.exit(2);
  }
  const problems = checkPaths(paths);
  if (problems.length) {
    console.error(`check-public: ${problems.length} problem(s) in what ships:\n${problems.map((p) => `  ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`check-public: nothing internal in ${paths.length} path(s)`);
}
