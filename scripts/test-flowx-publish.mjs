#!/usr/bin/env node
/**
 * Test that @flowx-finance/sui (and its deps) install and run correctly.
 *
 * Usage:
 *   node scripts/test-flowx-publish.mjs [--from-registry]
 *
 * Flags:
 *   --from-registry  Install from npm (packages must already be published).
 *                    Default: pack local dist/ and install from tarballs.
 *
 * What it does:
 *   1. Temporarily renames packages to @flowx-finance/*
 *   2. Patches dist/ files: replaces "@mysten/bcs"/"@mysten/utils" import
 *      strings with "@flowx-finance/bcs"/"@flowx-finance/utils"
 *   3. Runs `pnpm pack` to create tarballs with resolved deps
 *   4. Restores all modified files immediately after packing
 *   5. Creates a temp project, installs the tarballs with npm
 *   6. Asserts: @flowx-finance/* present, @mysten/bcs+utils absent
 *   7. Runs import smoke tests
 *   8. Cleans up
 */

import {
	mkdtempSync,
	rmSync,
	writeFileSync,
	existsSync,
	readFileSync,
	readdirSync,
} from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const FROM_REGISTRY = process.argv.includes('--from-registry');

// ---------- Package paths ----------
const PKG_PATHS = {
	utils: 'packages/utils/package.json',
	bcs: 'packages/bcs/package.json',
	sui: 'packages/sui/package.json',
};

// ---------- Helpers ----------
function run(cmd, opts = {}) {
	console.log(`$ ${cmd}`);
	execSync(cmd, { cwd: REPO_ROOT, stdio: 'inherit', ...opts });
}

function capture(cmd, opts = {}) {
	return execSync(cmd, { stdio: 'pipe', ...opts }).toString().trim();
}

function readPkg(relPath) {
	return JSON.parse(readFileSync(resolve(REPO_ROOT, relPath), 'utf8'));
}

function writePkg(relPath, pkg) {
	writeFileSync(resolve(REPO_ROOT, relPath), JSON.stringify(pkg, null, '\t') + '\n');
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
let tmpDir = null;
let pkgRestored = false;
const savedDistFiles = new Map();

function restoreAll() {
	if (!pkgRestored) {
		pkgRestored = true;
		// Restore dist files from in-memory originals
		for (const [path, content] of savedDistFiles) writeFileSync(path, content);
		if (savedDistFiles.size) console.log(`  restored ${savedDistFiles.size} dist file(s)`);

		try {
			execSync(`git restore ${Object.values(PKG_PATHS).join(' ')}`, {
				cwd: REPO_ROOT,
				stdio: 'pipe',
			});
			console.log('  package.json files restored');
		} catch (e) {
			console.error('Warning: git restore failed:', e.message);
		}
	}

	if (tmpDir) {
		console.log(`Removing temp dir ${tmpDir}`);
		rmSync(tmpDir, { recursive: true, force: true });
		tmpDir = null;
	}
}

process.on('exit', restoreAll);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

// ============================================================
// STEP 1 — Rename, patch dist, pack tarballs
// ============================================================
let installTarget;

if (FROM_REGISTRY) {
	console.log('\n=== Step 1: Using published packages from npm ===');
	installTarget = '@flowx-finance/sui @flowx-finance/bcs @flowx-finance/utils';
} else {
	console.log('\n=== Step 1: Renaming + patching + packing tarballs ===');

	const utilsPkg = readPkg(PKG_PATHS.utils);
	const bcsPkg = readPkg(PKG_PATHS.bcs);
	const suiPkg = readPkg(PKG_PATHS.sui);

	// Rename utils
	utilsPkg.name = '@flowx-finance/utils';
	writePkg(PKG_PATHS.utils, utilsPkg);

	// Rename bcs + resolve workspace dep to actual version
	bcsPkg.name = '@flowx-finance/bcs';
	if (bcsPkg.dependencies?.['@mysten/utils']) {
		bcsPkg.dependencies['@flowx-finance/utils'] = `^${utilsPkg.version}`;
		delete bcsPkg.dependencies['@mysten/utils'];
	}
	writePkg(PKG_PATHS.bcs, bcsPkg);

	// Rename sui + resolve workspace deps to actual versions
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
	console.log('  package.json renamed');

	// Patch dist import strings so installed packages reference @flowx-finance/*
	const bcsDist = patchDistDir('packages/bcs/dist', [['@mysten/utils', '@flowx-finance/utils']]);
	for (const [p, c] of bcsDist) savedDistFiles.set(p, c);

	const suiDist = patchDistDir('packages/sui/dist', [
		['@mysten/bcs', '@flowx-finance/bcs'],
		['@mysten/utils', '@flowx-finance/utils'],
	]);
	for (const [p, c] of suiDist) savedDistFiles.set(p, c);
	console.log(`  dist files patched (${savedDistFiles.size} files)`);

	// Pack each package — last line of output is the tarball path
	const packDest = tmpdir();
	const tarballs = {};
	for (const [key, relPath] of Object.entries(PKG_PATHS)) {
		const pkgDir = resolve(REPO_ROOT, relPath, '..');
		const output = capture(`pnpm pack --pack-destination ${packDest}`, { cwd: pkgDir });
		const tarball = output.split('\n').at(-1).trim();
		tarballs[key] = tarball;
		console.log(`  packed: ${tarball}`);
	}

	// Restore originals right after packing — tarballs have everything we need
	restoreAll();

	installTarget = Object.values(tarballs).join(' ');
}

// ============================================================
// STEP 2 — Create temp project and install
// ============================================================
console.log('\n=== Step 2: Installing in temp project ===');
tmpDir = mkdtempSync(resolve(tmpdir(), 'flowx-test-'));
console.log(`  temp dir: ${tmpDir}`);

writeFileSync(
	resolve(tmpDir, 'package.json'),
	JSON.stringify({ name: 'flowx-test', version: '1.0.0', type: 'module', private: true }, null, 2),
);

run(`npm install ${installTarget}`, { cwd: tmpDir });

// ============================================================
// STEP 3 — Assert dependency tree
// ============================================================
console.log('\n=== Step 3: Checking installed packages ===');

const checks = [
	[
		'@flowx-finance/utils installed',
		existsSync(resolve(tmpDir, 'node_modules/@flowx-finance/utils')),
	],
	['@flowx-finance/bcs installed', existsSync(resolve(tmpDir, 'node_modules/@flowx-finance/bcs'))],
	['@flowx-finance/sui installed', existsSync(resolve(tmpDir, 'node_modules/@flowx-finance/sui'))],
	// @mysten/bcs and @mysten/utils should NOT appear (they're fully replaced)
	[
		'@mysten/bcs NOT installed (replaced by @flowx-finance/bcs)',
		!existsSync(resolve(tmpDir, 'node_modules/@mysten/bcs')),
	],
	[
		'@mysten/utils NOT installed (replaced by @flowx-finance/utils)',
		!existsSync(resolve(tmpDir, 'node_modules/@mysten/utils')),
	],
];

const failed = [];
for (const [label, ok] of checks) {
	if (ok) {
		console.log(`  ✓ ${label}`);
	} else {
		console.error(`  ✗ ${label}`);
		failed.push(label);
	}
}

// ============================================================
// STEP 4 — Smoke-test imports
// ============================================================
console.log('\n=== Step 4: Smoke-testing imports ===');

const smokeFile = resolve(tmpDir, 'smoke.mjs');
writeFileSync(
	smokeFile,
	`
import { bcs as rawBcs } from '@flowx-finance/bcs';
import { bcs } from '@flowx-finance/sui/bcs';
import { Transaction } from '@flowx-finance/sui/transactions';
import { Ed25519Keypair } from '@flowx-finance/sui/keypairs/ed25519';
import { toBase64, fromBase64, isValidSuiAddress } from '@flowx-finance/sui/utils';

// @flowx-finance/bcs: encode/decode u64
const encoded = rawBcs.u64().serialize(42n).toBytes();
const decoded = rawBcs.u64().parse(encoded);
if (Number(decoded) !== 42) throw new Error('BCS u64 round-trip failed: got ' + decoded);
console.log('  ✓ @flowx-finance/bcs  u64 round-trip');

// @flowx-finance/sui/bcs: encode/decode u32
const suiEncoded = bcs.u32().serialize(7).toBytes();
if (bcs.u32().parse(suiEncoded) !== 7) throw new Error('Sui BCS u32 failed');
console.log('  ✓ @flowx-finance/sui/bcs  u32 round-trip');

// Keypair: generate address, validate format
const keypair = new Ed25519Keypair();
const address = keypair.getPublicKey().toSuiAddress();
if (!isValidSuiAddress(address)) throw new Error('Invalid Sui address: ' + address);
console.log('  ✓ Ed25519Keypair → address:', address.slice(0, 10) + '...');

// Transaction: build without error
const tx = new Transaction();
tx.setSender(address);
tx.setGasPrice(1000n);
tx.setGasBudget(10_000_000n);
console.log('  ✓ Transaction builder');

// Utils: base64 round-trip
const bytes = new Uint8Array([10, 20, 30, 40]);
if (fromBase64(toBase64(bytes)).toString() !== bytes.toString())
  throw new Error('base64 round-trip failed');
console.log('  ✓ toBase64 / fromBase64');

console.log('\\n  All imports work correctly!');
`,
);

try {
	run(`node ${smokeFile}`, { cwd: tmpDir });
} catch {
	failed.push('smoke tests (import errors above)');
}

// ============================================================
// STEP 5 — Summary
// ============================================================
console.log('\n=== Result ===');
if (failed.length === 0) {
	console.log('\n✓ All checks passed — @flowx-finance packages look correct.\n');
} else {
	console.error(`\n✗ ${failed.length} check(s) failed:`);
	for (const f of failed) console.error(`  - ${f}`);
	process.exit(1);
}
