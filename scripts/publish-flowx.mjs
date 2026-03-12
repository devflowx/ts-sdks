#!/usr/bin/env node
/**
 * Publish @mysten/sui (and its workspace deps) as @flowx-finance/* to npm.
 *
 * Usage:
 *   node scripts/publish-flowx.mjs [--skip-build] [--dry-run] [--tag <tag>]
 *
 * Flags:
 *   --skip-build   Skip the build step (use when dist/ is already up to date)
 *   --dry-run      Pass --dry-run to pnpm publish (shows what would be published)
 *   --tag <tag>    Publish under a specific dist-tag (default: "latest")
 *
 * What it does:
 *   1. Pre-flight: verifies npm auth
 *   2. Builds @mysten/sui (and deps) with turbo
 *   3. Temporarily renames packages to @flowx-finance/* and updates cross-deps
 *   4. Patches dist/ files: replaces "@mysten/bcs" / "@mysten/utils" import
 *      strings with "@flowx-finance/bcs" / "@flowx-finance/utils"
 *   5. Publishes utils → bcs → sui (skips versions already on npm)
 *   6. Restores all modified files (package.json + dist files)
 *
 * Prerequisites:
 *   npm login   (requires access to @flowx-finance org on npmjs.com)
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ---------- CLI args ----------
const args = process.argv.slice(2);
const SKIP_BUILD = args.includes('--skip-build');
const DRY_RUN = args.includes('--dry-run');
const tagIndex = args.indexOf('--tag');
const TAG = tagIndex !== -1 ? args[tagIndex + 1] : 'latest';

// ---------- Package paths ----------
const PKG_PATHS = {
	utils: 'packages/utils/package.json',
	bcs: 'packages/bcs/package.json',
	sui: 'packages/sui/package.json',
};

// ---------- Helpers ----------
function run(cmd) {
	console.log(`\n$ ${cmd}`);
	execSync(cmd, { cwd: REPO_ROOT, stdio: 'inherit' });
}

function readPkg(relPath) {
	return JSON.parse(readFileSync(resolve(REPO_ROOT, relPath), 'utf8'));
}

function writePkg(relPath, pkg) {
	writeFileSync(resolve(REPO_ROOT, relPath), JSON.stringify(pkg, null, '\t') + '\n');
}

function isAlreadyPublished(name, version) {
	try {
		execSync(`npm view ${name}@${version} version`, { stdio: 'pipe' });
		return true;
	} catch {
		return false;
	}
}

/**
 * Walk a directory and patch import strings in compiled JS/TS declaration files.
 * Returns a Map<absolutePath, originalContent> so the caller can restore later.
 *
 * Only replaces occurrences inside `from "..."` / `require("...")` strings to
 * avoid touching Symbol.for("@mysten/...") brand identifiers.
 */
const PATCH_EXTS = ['.mjs', '.cjs', '.d.mts', '.d.cts'];

function patchDistDir(relDir, replacements) {
	const saved = new Map();
	const absDir = resolve(REPO_ROOT, relDir);

	function walk(dir) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = resolve(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (PATCH_EXTS.some((ext) => entry.name.endsWith(ext))) {
				const original = readFileSync(full, 'utf8');
				let patched = original;
				for (const [from, to] of replacements) {
					// Match only as a module specifier: from "pkg" or require("pkg")
					patched = patched.replaceAll(`"${from}"`, `"${to}"`);
					patched = patched.replaceAll(`'${from}'`, `'${to}'`);
				}
				if (patched !== original) {
					saved.set(full, original);
					writeFileSync(full, patched);
				}
			}
		}
	}

	walk(absDir);
	return saved;
}

// ---------- Cleanup ----------
let restored = false;
const savedDistFiles = new Map(); // path → original content

function restore() {
	if (restored) return;
	restored = true;
	console.log('\nRestoring original files...');

	// Restore dist files from in-memory originals
	for (const [path, content] of savedDistFiles) {
		writeFileSync(path, content);
	}
	if (savedDistFiles.size) console.log(`  restored ${savedDistFiles.size} dist file(s)`);

	// Restore package.json files via git
	try {
		execSync(`git restore ${Object.values(PKG_PATHS).join(' ')}`, {
			cwd: REPO_ROOT,
			stdio: 'inherit',
		});
	} catch (e) {
		console.error('Warning: git restore failed:', e.message);
		console.error(
			'Run manually: git checkout -- packages/utils/package.json packages/bcs/package.json packages/sui/package.json',
		);
	}
}

process.on('exit', restore);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

// ---------- Step 0: Pre-flight ----------
console.log('\n=== Step 0: Pre-flight checks ===');

if (!DRY_RUN) {
	try {
		const user = execSync('npm whoami', { stdio: 'pipe' }).toString().trim();
		console.log(`  npm user: ${user}`);
	} catch {
		console.error('Error: not logged in to npm.');
		console.error('Run: npm login  (then ensure you have access to @flowx-finance org)');
		process.exit(1);
	}
}

// ---------- Step 1: Build ----------
if (!SKIP_BUILD) {
	console.log('\n=== Step 1: Building packages ===');
	run('pnpm turbo build --filter=@mysten/sui');
} else {
	console.log('\n=== Step 1: Skipping build (--skip-build) ===');
}

// ---------- Step 2: Rename package.json files ----------
console.log('\n=== Step 2: Renaming packages to @flowx-finance scope ===');

const utilsPkg = readPkg(PKG_PATHS.utils);
utilsPkg.name = '@flowx-finance/utils';
writePkg(PKG_PATHS.utils, utilsPkg);
console.log('  @mysten/utils  → @flowx-finance/utils');

const bcsPkg = readPkg(PKG_PATHS.bcs);
bcsPkg.name = '@flowx-finance/bcs';
if (bcsPkg.dependencies?.['@mysten/utils']) {
	bcsPkg.dependencies['@flowx-finance/utils'] = `^${utilsPkg.version}`;
	delete bcsPkg.dependencies['@mysten/utils'];
}
writePkg(PKG_PATHS.bcs, bcsPkg);
console.log('  @mysten/bcs    → @flowx-finance/bcs');

const suiPkg = readPkg(PKG_PATHS.sui);
suiPkg.name = '@flowx-finance/sui';
if (suiPkg.dependencies?.['@mysten/bcs']) {
	suiPkg.dependencies['@flowx-finance/bcs'] = `^${bcsPkg.version}`;
	delete suiPkg.dependencies['@mysten/bcs'];
}
if (suiPkg.dependencies?.['@mysten/utils']) {
	suiPkg.dependencies['@flowx-finance/utils'] = `^${utilsPkg.version}`;
	delete suiPkg.dependencies['@mysten/utils'];
}
writePkg(PKG_PATHS.sui, suiPkg);
console.log('  @mysten/sui    → @flowx-finance/sui');

// ---------- Step 3: Patch dist import strings ----------
console.log('\n=== Step 3: Patching dist/ import strings ===');

// packages/bcs/dist: "@mysten/utils" → "@flowx-finance/utils"
const bcsSaved = patchDistDir('packages/bcs/dist', [['@mysten/utils', '@flowx-finance/utils']]);
for (const [p, _] of bcsSaved) savedDistFiles.set(p, _);
console.log(`  packages/bcs/dist  — patched ${bcsSaved.size} file(s)`);

// packages/sui/dist: both bcs and utils
const suiSaved = patchDistDir('packages/sui/dist', [
	['@mysten/bcs', '@flowx-finance/bcs'],
	['@mysten/utils', '@flowx-finance/utils'],
]);
for (const [p, _] of suiSaved) savedDistFiles.set(p, _);
console.log(`  packages/sui/dist  — patched ${suiSaved.size} file(s)`);

// ---------- Step 4: Publish ----------
console.log('\n=== Step 4: Publishing packages ===');

const publishFlags = [
	'--no-git-checks',
	'--access public',
	`--tag ${TAG}`,
	DRY_RUN ? '--dry-run' : '',
]
	.filter(Boolean)
	.join(' ');

const packages = [
	{ filter: '@flowx-finance/utils', pkg: utilsPkg },
	{ filter: '@flowx-finance/bcs', pkg: bcsPkg },
	{ filter: '@flowx-finance/sui', pkg: suiPkg },
];

const published = [];
const skipped = [];

for (const { filter, pkg } of packages) {
	if (!DRY_RUN && isAlreadyPublished(pkg.name, pkg.version)) {
		console.log(`\n  Skipping ${pkg.name}@${pkg.version} — already published on npm`);
		skipped.push(`${pkg.name}@${pkg.version}`);
	} else {
		run(`pnpm --filter ${filter} publish ${publishFlags}`);
		published.push(`${pkg.name}@${pkg.version}`);
	}
}

// ---------- Summary ----------
console.log('\n✓ Done!');
if (published.length) {
	console.log('\nPublished:');
	for (const p of published) console.log(`  ${p}`);
}
if (skipped.length) {
	console.log('\nSkipped (already on npm):');
	for (const p of skipped) console.log(`  ${p}`);
}
if (DRY_RUN) console.log('\n  (dry run — nothing actually published)');
