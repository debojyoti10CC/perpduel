import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function patchDistFile(filePath) {
    let text;
    try {
        text = await readFile(filePath, 'utf8');
    } catch {
        console.warn(`[patch-liveline] Missing file, skipping: ${filePath}`);
        return { ok: false, changed: false };
    }

    let next = text;
    let didChange = false;
    let ok = true;

    // 1) Liveline draws a horizontal dashed "current price" line by default in `drawLine()`.
    // The public API doesn't expose a prop to disable it, so we patch the default.
    if (next.includes('skipDashLine = false')) {
        next = next.replace('skipDashLine = false', 'skipDashLine = true');
        didChange = didChange || next !== text;
    } else if (!next.includes('skipDashLine = true')) {
        console.warn(`[patch-liveline] Pattern not found (package changed?): ${filePath}`);
        ok = false;
    }

    // 1b) Liveline always draws a time-axis baseline even if labels are empty. For tiny inline charts
    // we pass `formatTime={() => ""}`; hide the axis entirely in that case.
    const timeAxisOld = [
        '  for (const key of targets) {',
        '    const text = formatTime(key / 100);',
        '    const existing = state.labels.get(key);',
        '    if (!existing) {',
        '      state.labels.set(key, { alpha: 0, text });',
        '    } else {',
        '      existing.text = text;',
        '    }',
        '  }',
        '  for (const [key, label] of state.labels) {',
    ].join('\n');

    const timeAxisNew = [
        '  for (const key of targets) {',
        '    const text = formatTime(key / 100);',
        '    if (!text) {',
        '      targets.delete(key);',
        '      state.labels.delete(key);',
        '      continue;',
        '    }',
        '    const existing = state.labels.get(key);',
        '    if (!existing) {',
        '      state.labels.set(key, { alpha: 0, text });',
        '    } else {',
        '      existing.text = text;',
        '    }',
        '  }',
        '  if (targets.size === 0) {',
        '    state.labels.clear();',
        '    return;',
        '  }',
        '  for (const [key, label] of state.labels) {',
    ].join('\n');

    if (next.includes(timeAxisNew)) {
        // already patched
    } else if (next.includes(timeAxisOld)) {
        next = next.replace(timeAxisOld, timeAxisNew);
        didChange = true;
    } else {
        console.warn(`[patch-liveline] Time-axis pattern not found: ${filePath}`);
        ok = false;
    }

    // 2) Make scrub dots follow the drawn spline curve by using the same monotone cubic
    // interpolation as `drawSpline()` instead of linear `interpolateAtTime()`.
    const splineFnSignature = 'function interpolateSplineAtTime(points, time) {';
    const linearFnSignature = 'function interpolateAtTime(points, time) {';

    if (!next.includes(splineFnSignature)) {
        if (!next.includes(linearFnSignature)) {
            console.warn(`[patch-liveline] interpolateAtTime signature not found: ${filePath}`);
            ok = false;
        } else {
            const splineFn = [
                splineFnSignature,
                '  if (points.length === 0) return null;',
                '  if (points.length === 1) return points[0].value;',
                '  if (time <= points[0].time) return points[0].value;',
                '  if (time >= points[points.length - 1].time) return points[points.length - 1].value;',
                '  const n = points.length;',
                '  if (n === 2) return interpolateAtTime(points, time);',
                '  const h = new Array(n - 1);',
                '  const delta = new Array(n - 1);',
                '  for (let i = 0; i < n - 1; i++) {',
                '    const dx = points[i + 1].time - points[i].time;',
                '    h[i] = dx;',
                '    delta[i] = dx === 0 ? 0 : (points[i + 1].value - points[i].value) / dx;',
                '  }',
                '  const m = new Array(n);',
                '  m[0] = delta[0];',
                '  m[n - 1] = delta[n - 2];',
                '  for (let i = 1; i < n - 1; i++) {',
                '    if (delta[i - 1] * delta[i] <= 0) m[i] = 0;',
                '    else m[i] = (delta[i - 1] + delta[i]) / 2;',
                '  }',
                '  for (let i = 0; i < n - 1; i++) {',
                '    if (delta[i] === 0) {',
                '      m[i] = 0;',
                '      m[i + 1] = 0;',
                '    } else {',
                '      const alpha = m[i] / delta[i];',
                '      const beta = m[i + 1] / delta[i];',
                '      const s2 = alpha * alpha + beta * beta;',
                '      if (s2 > 9) {',
                '        const s = 3 / Math.sqrt(s2);',
                '        m[i] = s * alpha * delta[i];',
                '        m[i + 1] = s * beta * delta[i];',
                '      }',
                '    }',
                '  }',
                '  let lo = 0;',
                '  let hi = n - 1;',
                '  while (hi - lo > 1) {',
                '    const mid = lo + hi >> 1;',
                '    if (points[mid].time <= time) lo = mid;',
                '    else hi = mid;',
                '  }',
                '  const p0 = points[lo];',
                '  const p1 = points[hi];',
                '  const dx = p1.time - p0.time;',
                '  if (dx === 0) return p0.value;',
                '  const t = (time - p0.time) / dx;',
                '  const t2 = t * t;',
                '  const t3 = t2 * t;',
                '  const h00 = 2 * t3 - 3 * t2 + 1;',
                '  const h10 = t3 - 2 * t2 + t;',
                '  const h01 = -2 * t3 + 3 * t2;',
                '  const h11 = t3 - t2;',
                '  return h00 * p0.value + h10 * dx * m[lo] + h01 * p1.value + h11 * dx * m[hi];',
                '}',
                '',
            ].join('\n');

            const inserted = next.replace(linearFnSignature, `${splineFn}${linearFnSignature}`);
            if (inserted === next) {
                console.warn(`[patch-liveline] Failed to insert spline interpolator: ${filePath}`);
                ok = false;
            } else {
                next = inserted;
                didChange = true;
            }
        }
    }

    // Replace hover interpolation in both single-series and multi-series scrub paths.
    const singleOld = 'const v = interpolateAtTime(visible, t);';
    const singleNew = 'const v = interpolateSplineAtTime(visible, t);';
    const multiOld = 'const v = interpolateAtTime(entry.visible, t);';
    const multiNew = 'const v = interpolateSplineAtTime(entry.visible, t);';

    if (next.includes(singleNew)) {
        // already patched
    } else if (next.includes(singleOld)) {
        next = next.replace(singleOld, singleNew);
        didChange = true;
    } else {
        console.warn(`[patch-liveline] Hover pattern not found (single-series): ${filePath}`);
        ok = false;
    }

    if (next.includes(multiNew)) {
        // already patched
    } else if (next.includes(multiOld)) {
        next = next.replace(multiOld, multiNew);
        didChange = true;
    } else {
        console.warn(`[patch-liveline] Hover pattern not found (multi-series): ${filePath}`);
        ok = false;
    }

    // 3) Liveline dims the chart to the right of the scrub cursor by reducing globalAlpha.
    // This looks like a persistent opacity bug when the cursor happens to sit over the chart.
    const scrubDimOld = 'ctx.globalAlpha = incomingAlpha * (1 - scrubAmount * 0.6);';
    const scrubDimNew = 'ctx.globalAlpha = incomingAlpha;';

    if (next.includes(scrubDimOld)) {
        next = next.replaceAll(scrubDimOld, scrubDimNew);
        didChange = true;
    } else if (!next.includes(scrubDimNew)) {
        console.warn(`[patch-liveline] Scrub-dim pattern not found: ${filePath}`);
        ok = false;
    }

    // 4) Replace SF Mono chart fonts with Inter/system fonts.
    const fontReplacements = [
        {
            label: 'labelFont',
            old: '11px "SF Mono", Menlo, Monaco, "Cascadia Code", monospace',
            next: '11px Inter, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        },
        {
            label: 'valueFont',
            old: '600 11px "SF Mono", Menlo, monospace',
            next: '600 11px Inter, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        },
        {
            label: 'badgeFont',
            old: '500 11px "SF Mono", Menlo, monospace',
            next: '500 11px Inter, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        },
        {
            label: 'crosshairFont',
            old: '400 13px "SF Mono", Menlo, monospace',
            next: '400 13px Inter, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        },
    ];

    for (const r of fontReplacements) {
        if (next.includes(r.next)) continue; // already patched
        if (next.includes(r.old)) {
            next = next.replaceAll(r.old, r.next);
            didChange = true;
        } else {
            console.warn(`[patch-liveline] Font pattern not found (${r.label}): ${filePath}`);
            ok = false;
        }
    }

    // 5) Add a horizontal crosshair line while scrubbing (Liveline draws vertical only by default).
    const crosshairOld = [
        '  ctx.beginPath();',
        '  ctx.moveTo(hoverX, pad.top);',
        '  ctx.lineTo(hoverX, h - pad.bottom);',
        '  ctx.stroke();',
        '  ctx.restore();',
    ].join('\n');

    const crosshairNew = [
        '  ctx.beginPath();',
        '  ctx.moveTo(hoverX, pad.top);',
        '  ctx.lineTo(hoverX, h - pad.bottom);',
        '  ctx.stroke();',
        '  ctx.beginPath();',
        '  ctx.moveTo(pad.left, y);',
        '  ctx.lineTo(layout.w - pad.right, y);',
        '  ctx.stroke();',
        '  ctx.restore();',
    ].join('\n');

    if (next.includes(crosshairNew)) {
        // already patched
    } else if (next.includes(crosshairOld)) {
        next = next.replace(crosshairOld, crosshairNew);
        didChange = true;
    } else {
        console.warn(`[patch-liveline] Crosshair pattern not found: ${filePath}`);
        ok = false;
    }

    // 6) Fix an infinite loop in `drawGrid()` when the value range is tiny but nonzero.
    // With flat single-point data (e.g. a brand-new variant mint with one candle), the
    // animated y-range can settle at a denormal width (~1e-13 at a ~$172 price). The grid
    // step (`fine`) then underflows below the float ULP of the price, so `val += fine`
    // no longer advances and the unbounded for-loop hangs the main thread.
    // Repro: client-side nav /sk-hynix -> /sk-hynix?solana=<ondo mint> froze the tab.
    const gridGuardOld = [
        '  const first = Math.ceil(minVal / fine) * fine;',
        '  for (let val = first; val <= maxVal; val += fine) {',
    ].join('\n');

    const gridGuardNew = [
        '  const first = Math.ceil(minVal / fine) * fine;',
        '  if (!Number.isFinite(first) || !(fine > 0) || first + fine === first) return;',
        '  for (let val = first; val <= maxVal; val += fine) {',
    ].join('\n');

    if (next.includes(gridGuardNew)) {
        // already patched
    } else if (next.includes(gridGuardOld)) {
        next = next.replace(gridGuardOld, gridGuardNew);
        didChange = true;
    } else {
        console.warn(`[patch-liveline] Grid degenerate-range pattern not found: ${filePath}`);
        ok = false;
    }

    // 7) Speed up the line ↔ candlestick morph used by our external chart-mode toggle.
    const modeTransitionReplacements = [
        {
            label: 'lineMorphDuration',
            old: 'var LINE_MORPH_MS = 500;',
            next: 'var LINE_MORPH_MS = 240;',
        },
        {
            label: 'lineDensityDuration',
            old: 'var LINE_DENSITY_MS = 350;',
            next: 'var LINE_DENSITY_MS = 180;',
        },
    ];

    for (const r of modeTransitionReplacements) {
        if (next.includes(r.next)) continue; // already patched
        if (next.includes(r.old)) {
            next = next.replaceAll(r.old, r.next);
            didChange = true;
        } else {
            console.warn(`[patch-liveline] Mode transition pattern not found (${r.label}): ${filePath}`);
            ok = false;
        }
    }

    if (!didChange) return { ok, changed: false };
    await writeFile(filePath, next, 'utf8');
    console.log(`[patch-liveline] Patched: ${filePath}`);
    return { ok, changed: true };
}

async function main() {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = dirname(here);
    const requireFromProject = createRequire(join(repoRoot, 'package.json'));
    const pkgDir = dirname(dirname(requireFromProject.resolve('liveline')));
    const distIndexJs = join(pkgDir, 'dist', 'index.js');
    const distIndexCjs = join(pkgDir, 'dist', 'index.cjs');

    const results = await Promise.all([patchDistFile(distIndexJs), patchDistFile(distIndexCjs)]);
    const okCount = results.filter(r => r.ok).length;
    const changedCount = results.filter(r => r.changed).length;

    if (okCount === results.length) {
        console.log(`[patch-liveline] Done (changed ${changedCount}/${results.length})`);
    } else {
        throw new Error(`Expected Liveline 0.0.7 source patterns were missing in ${results.length - okCount} build(s)`);
    }
}

main().catch(error => {
    console.error('[patch-liveline] Failed to apply the pinned chart fixes:', error);
    process.exitCode = 1;
});
