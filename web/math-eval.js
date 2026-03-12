// math-eval.js — Clickable math formula evaluation.
//
// Formulas ending with "=" in preview mode become clickable. On click the
// code resolves variable dependencies across all inline ($…$) and block
// ($$…$$) formulas in the note, then evaluates the expression and shows
// the result (≤ 10 significant figures) or "?" when unsolvable.

function extractAllMathExpressions(markdown) {
  const exprs = [];
  let i = 0;
  while (i < markdown.length) {
    if (markdown[i] === '\\') { i += 2; continue; }
    if (markdown[i] !== '$') { i++; continue; }
    if (markdown.slice(i, i + 2) === '$$') {
      const start = i + 2;
      const end = markdown.indexOf('$$', start);
      if (end === -1) { i++; continue; }
      exprs.push({ tex: markdown.slice(start, end).trim(), type: 'block', index: i });
      i = end + 2;
    } else {
      const start = i + 1;
      let j = start;
      while (j < markdown.length) {
        if (markdown[j] === '\\') { j += 2; continue; }
        if (markdown[j] === '$') break;
        j++;
      }
      if (j >= markdown.length) { i++; continue; }
      exprs.push({ tex: markdown.slice(start, j).trim(), type: 'inline', index: i });
      i = j + 1;
    }
  }
  return exprs;
}

function parseBraceGroup(str, startIdx) {
  let depth = 1;
  let i = startIdx + 1;
  while (i < str.length && depth > 0) {
    if (str[i] === '{') depth++;
    else if (str[i] === '}') depth--;
    i++;
  }
  return { content: str.slice(startIdx + 1, i - 1), endIdx: i };
}

function expandLatexFrac(expr) {
  let result = expr;
  for (let iter = 0; iter < 50; iter++) {
    const idx = result.indexOf('\\frac');
    if (idx === -1) break;
    let i = idx + 5;
    while (i < result.length && result[i] === ' ') i++;
    if (result[i] !== '{') break;
    const { content: num, endIdx: numEnd } = parseBraceGroup(result, i);
    let j = numEnd;
    while (j < result.length && result[j] === ' ') j++;
    if (result[j] !== '{') break;
    const { content: den, endIdx: denEnd } = parseBraceGroup(result, j);
    result = result.slice(0, idx) + `((${num})/(${den}))` + result.slice(denEnd);
  }
  return result;
}

function expandLatexSqrt(expr) {
  let result = expr;
  for (let iter = 0; iter < 50; iter++) {
    const nthMatch = result.match(/\\sqrt\[([^\]]+)\]/);
    if (nthMatch) {
      let i = nthMatch.index + nthMatch[0].length;
      while (i < result.length && result[i] === ' ') i++;
      if (result[i] === '{') {
        const { content: inner, endIdx } = parseBraceGroup(result, i);
        result = result.slice(0, nthMatch.index) +
          `Math.pow((${inner}),1/(${nthMatch[1]}))` +
          result.slice(endIdx);
        continue;
      }
    }
    const sqrtIdx = result.search(/\\sqrt(?!\[)/);
    if (sqrtIdx !== -1) {
      let i = sqrtIdx + 5;
      while (i < result.length && result[i] === ' ') i++;
      if (result[i] === '{') {
        const { content: inner, endIdx } = parseBraceGroup(result, i);
        result = result.slice(0, sqrtIdx) + `Math.sqrt(${inner})` + result.slice(endIdx);
        continue;
      }
    }
    break;
  }
  return result;
}

function substituteVarsInLatex(texExpr, varMap) {
  const latexVars = Object.entries(varMap)
    .filter(([k]) => k.startsWith('\\'))
    .sort(([a], [b]) => b.length - a.length);
  const plainVars = Object.entries(varMap)
    .filter(([k]) => !k.startsWith('\\'))
    .sort(([a], [b]) => b.length - a.length);

  let result = texExpr;

  for (const [varName, val] of latexVars) {
    const esc = varName.replace(/\\/g, '\\\\');
    result = result.replace(new RegExp(esc + '(?![a-zA-Z])', 'g'), `(${val})`);
  }

  if (plainVars.length === 0) return result;

  let output = '';
  let i = 0;
  while (i < result.length) {
    const ch = result[i];

    if (ch === '\\') {
      let cmd = '\\';
      i++;
      while (i < result.length && /[a-zA-Z]/.test(result[i])) cmd += result[i++];
      output += cmd;
      continue;
    }

    if (/[a-zA-Z]/.test(ch)) {
      let matched = false;
      for (const [varName, val] of plainVars) {
        if (result.slice(i, i + varName.length) !== varName) continue;
        const nextCh = result[i + varName.length] || '';
        if (varName.length === 1) {
          if (nextCh !== '_') {
            output += `(${val})`;
            i += varName.length;
            matched = true;
            break;
          }
        } else {
          if (!/[a-zA-Z0-9_]/.test(nextCh)) {
            output += `(${val})`;
            i += varName.length;
            matched = true;
            break;
          }
        }
      }
      if (!matched) { output += ch; i++; }
      continue;
    }

    output += ch;
    i++;
  }
  return output;
}

function latexToJsExpr(tex) {
  let expr = tex;

  expr = expandLatexFrac(expr);
  expr = expandLatexSqrt(expr);

  expr = expr.replace(/\\pi\b/g, `(${Math.PI})`);
  expr = expr.replace(/\\infty\b/g, 'Infinity');

  expr = expr.replace(/\\arcsin\b|\\asin\b/g, 'Math.asin');
  expr = expr.replace(/\\arccos\b|\\acos\b/g, 'Math.acos');
  expr = expr.replace(/\\arctan\b|\\atan\b/g, 'Math.atan');

  expr = expr.replace(/\\sin\b/g, 'Math.sin');
  expr = expr.replace(/\\cos\b/g, 'Math.cos');
  expr = expr.replace(/\\tan\b/g, 'Math.tan');
  expr = expr.replace(/\\ln\b/g, 'Math.log');
  expr = expr.replace(/\\log\b/g, 'Math.log10');
  expr = expr.replace(/\\exp\b/g, 'Math.exp');
  expr = expr.replace(/\\abs\b/g, 'Math.abs');
  expr = expr.replace(/\\min\b/g, 'Math.min');
  expr = expr.replace(/\\max\b/g, 'Math.max');
  expr = expr.replace(/\\floor\b/g, 'Math.floor');
  expr = expr.replace(/\\ceil\b/g, 'Math.ceil');

  expr = expr.replace(/\\cdot\b/g, '*');
  expr = expr.replace(/\\times\b/g, '*');
  expr = expr.replace(/\\div\b/g, '/');

  expr = expr.replace(/\\left\s*\(/g, '(');
  expr = expr.replace(/\\left\s*\[/g, '(');
  expr = expr.replace(/\\left\s*\|/g, 'Math.abs(');
  expr = expr.replace(/\\right\s*\)/g, ')');
  expr = expr.replace(/\\right\s*\]/g, ')');
  expr = expr.replace(/\\right\s*\|/g, ')');

  expr = expr.replace(/\^\{/g, '**(');
  expr = expr.replace(/\^([a-zA-Z0-9.(])/g, '**$1');

  expr = expr.replace(/\{/g, '(').replace(/\}/g, ')');

  expr = expr.replace(/(\d+\.?\d*)\s*\(/g, '$1*(');
  expr = expr.replace(/\)\s*\(/g, ')*(');
  expr = expr.replace(/\)\s*([a-zA-Z])/g, ')*$1');

  expr = expr.replace(/\\[a-zA-Z]+/g, 'undefined');

  return expr.trim();
}

function evaluateLatexExpr(texExpr, varMap) {
  try {
    const substituted = substituteVarsInLatex(texExpr, varMap);
    const jsExpr = latexToJsExpr(substituted);
    const result = new Function(`"use strict"; return (${jsExpr})`)();
    if (typeof result === 'number') {
      return result;
    }
    return null;
  } catch (_) {
    return null;
  }
}

function buildMathVariableMap(expressions) {
  const varMap = {};
  const assignRe = /^(\\?[a-zA-Z][a-zA-Z0-9]*(?:_\{[^}]+\}|_[a-zA-Z0-9])?)\s*=\s*(.+)$/;
  const numericRe = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

  for (const { tex } of expressions) {
    const m = tex.match(assignRe);
    if (!m) continue;
    const rhs = m[2].trim();
    if (numericRe.test(rhs)) varMap[m[1]] = parseFloat(rhs);
  }

  for (let changed = true, iters = 0; changed && iters < 20; iters++) {
    changed = false;
    for (const { tex } of expressions) {
      const m = tex.match(assignRe);
      if (!m || m[1] in varMap) continue;
      const val = evaluateLatexExpr(m[2].trim(), varMap);
      if (val !== null) { varMap[m[1]] = val; changed = true; }
    }
  }

  return varMap;
}

function formatMathResult(value) {
  if (!isFinite(value)) return value > 0 ? '∞' : '-∞';
  const abs = Math.abs(value);
  const precise = parseFloat(value.toPrecision(10));
  if (abs !== 0 && (abs >= 1e10 || abs < 1e-4)) return precise.toExponential();
  return precise.toString();
}

function saveFormulaResult(mathExpr, resultStr) {
  if (!currentFileName || currentFileName === PROJECTS_NOTE) return;
  const content = textarea.value;
  const { type } = mathExpr;
  const index = findCurrentFormulaIndex(content, mathExpr);
  if (index === -1) return;
  let newContent;

  if (type === 'block') {
    const innerStart = index + 2;
    const innerEnd = content.indexOf('$$', innerStart);
    if (innerEnd === -1) return;
    const inner = content.slice(innerStart, innerEnd);
    const newInner = inner.replace(/=\s*$/, `= ${resultStr}`);
    if (newInner === inner) return;
    newContent = content.slice(0, innerStart) + newInner + content.slice(innerEnd);
  } else {
    const innerStart = index + 1;
    let j = innerStart;
    while (j < content.length) {
      if (content[j] === '\\') { j += 2; continue; }
      if (content[j] === '$') break;
      j++;
    }
    if (j >= content.length) return;
    const inner = content.slice(innerStart, j);
    const newInner = inner.replace(/=\s*$/, `= ${resultStr}`);
    if (newInner === inner) return;
    newContent = content.slice(0, innerStart) + newInner + content.slice(j);
  }

  textarea.value = newContent;
  NoteStorage.setNote(currentFileName, newContent);
  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
}

function findCurrentFormulaIndex(content, mathExpr) {
  const texBase = mathExpr.tex.replace(/=\s*$/, '=').trimEnd();
  const candidates = [];
  let i = 0;
  while (i < content.length) {
    if (content[i] === '\\') { i += 2; continue; }
    if (content[i] !== '$') { i++; continue; }
    if (mathExpr.type === 'block') {
      if (content.slice(i, i + 2) !== '$$') { i++; continue; }
      const start = i + 2;
      const end = content.indexOf('$$', start);
      if (end === -1) { i++; continue; }
      const inner = content.slice(start, end).trim();
      if (inner.startsWith(texBase)) candidates.push(i);
      i = end + 2;
    } else {
      if (content.slice(i, i + 2) === '$$') { i += 2; continue; }
      const start = i + 1;
      let j = start;
      while (j < content.length) {
        if (content[j] === '\\') { j += 2; continue; }
        if (content[j] === '$') break;
        j++;
      }
      if (j >= content.length) { i++; continue; }
      const inner = content.slice(start, j).trim();
      if (inner.startsWith(texBase)) candidates.push(i);
      i = j + 1;
    }
  }
  if (candidates.length === 0) return -1;
  let best = candidates[0];
  let bestDist = Math.abs(best - mathExpr.index);
  for (let c = 1; c < candidates.length; c++) {
    const dist = Math.abs(candidates[c] - mathExpr.index);
    if (dist < bestDist) { best = candidates[c]; bestDist = dist; }
  }
  return best;
}

function unsaveFormulaResult(mathExpr) {
  if (!currentFileName || currentFileName === PROJECTS_NOTE) return;
  const content = textarea.value;
  const { type } = mathExpr;
  const index = findCurrentFormulaIndex(content, mathExpr);
  if (index === -1) return;
  let newContent;

  if (type === 'block') {
    const innerStart = index + 2;
    const innerEnd = content.indexOf('$$', innerStart);
    if (innerEnd === -1) return;
    const inner = content.slice(innerStart, innerEnd);
    const newInner = inner.replace(/=\s*\S.*$/, '=');
    if (newInner === inner) return;
    newContent = content.slice(0, innerStart) + newInner + content.slice(innerEnd);
  } else {
    const innerStart = index + 1;
    let j = innerStart;
    while (j < content.length) {
      if (content[j] === '\\') { j += 2; continue; }
      if (content[j] === '$') break;
      j++;
    }
    if (j >= content.length) return;
    const inner = content.slice(innerStart, j);
    const newInner = inner.replace(/=\s*\S.*$/, '=');
    if (newInner === inner) return;
    newContent = content.slice(0, innerStart) + newInner + content.slice(j);
  }

  textarea.value = newContent;
  NoteStorage.setNote(currentFileName, newContent);
  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
}

function makeFormulaClickable(container, texSource, varMap, mathExpr) {
  container.classList.add('math-evaluable');
  container.title = 'Click to evaluate';

  const isDisplay = container.getAttribute('display') === 'true';

  container.addEventListener('click', (e) => {
    e.stopPropagation();

    const existingResult = container.nextElementSibling;
    if (existingResult && existingResult.classList.contains('math-result')) {
      existingResult.remove();
      container.title = 'Click to evaluate';
      if (mathExpr) unsaveFormulaResult(mathExpr);
      return;
    }

    const exprTex = texSource.replace(/=\s*$/, '').trim();
    const result = evaluateLatexExpr(exprTex, varMap);

    const resultEl = document.createElement(isDisplay ? 'div' : 'span');
    resultEl.classList.add('math-result');
    if (isDisplay) resultEl.classList.add('math-result-block');
    container.after(resultEl);

    if (result !== null && window.MathJax) {
      resultEl.innerHTML = `\\(${formatMathResult(result)}\\)`;
      MathJax.typesetPromise([resultEl]);
    } else {
      resultEl.textContent = result === null ? '?' : formatMathResult(result);
    }

    if (result !== null && mathExpr) {
      saveFormulaResult(mathExpr, formatMathResult(result));
      container.title = 'Click to hide result';
    }
  });
}

function setupClickableMathFormulas() {
  const mathExprs = extractAllMathExpressions(textarea.value);
  if (mathExprs.length === 0) return;

  const varMap = buildMathVariableMap(mathExprs);
  const containers = Array.from(previewDiv.querySelectorAll('mjx-container'));

  containers.forEach((container, idx) => {
    let texSource = container.querySelector('math')?.getAttribute('alttext') ?? '';
    const mathExpr = idx < mathExprs.length ? mathExprs[idx] : null;
    if (!texSource && mathExpr) texSource = mathExpr.tex;

    if (texSource.trim().endsWith('=')) {
      makeFormulaClickable(container, texSource.trim(), varMap, mathExpr);
    }
  });
}

function setupMathWheelScroll() {
  previewDiv.addEventListener('wheel', (e) => {
    const container = e.target.closest('mjx-container');
    if (!container) return;
    // Only intercept when the formula can actually scroll horizontally.
    if (container.scrollWidth <= container.clientWidth) return;
    e.preventDefault();
    container.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
  }, { passive: false });
}

// Register the wheel-scroll handler once after the DOM is ready.
document.addEventListener('DOMContentLoaded', setupMathWheelScroll);
