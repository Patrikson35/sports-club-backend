const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const db = require('../config/database');

const router = express.Router();

const METRIC_TYPES = new Set(['number', 'minutes', 'percent', 'boolean']);
const METRIC_MODES = new Set(['manual', 'formula']);
const OPS = new Set(['+', '-', '*', '/', '(', ')']);
const FNS = new Set(['SUM', 'AVG', 'MIN', 'MAX']);

const normalizeValueTypes = (source) => {
  const input = Array.isArray(source) ? source : [source];
  const normalized = [...new Set(input.map((item) => String(item || '').trim()).filter((item) => METRIC_TYPES.has(item)))];
  return normalized.length > 0 ? normalized : ['number'];
};

const createDefaultMetrics = () => ([
  { id: 'default-trainings-count', name: 'Počet tréningov', shortName: '', type: 'number', valueTypes: ['number'], mode: 'manual', isDefault: true, isActive: true, formula: [] },
  { id: 'default-matches-count', name: 'Počet zápasov', shortName: '', type: 'number', valueTypes: ['number'], mode: 'manual', isDefault: true, isActive: true, formula: [] },
  {
    id: 'default-load-days',
    name: 'Dni záťaže',
    shortName: '',
    type: 'number',
    valueTypes: ['number'],
    mode: 'formula',
    isDefault: true,
    isActive: true,
    formula: [
      { type: 'variable', metricId: 'default-trainings-count' },
      { type: 'operator', op: '+' },
      { type: 'variable', metricId: 'default-matches-count' }
    ]
  },
  { id: 'default-game-load', name: 'Herná záťaž (minúty)', shortName: '', type: 'minutes', valueTypes: ['minutes'], mode: 'manual', isDefault: true, isActive: true, formula: [] },
  { id: 'default-training-intensity', name: 'Intenzita tréningu', shortName: '', type: 'percent', valueTypes: ['percent'], mode: 'manual', isDefault: true, isActive: true, formula: [] },
  { id: 'default-attendance', name: 'Dochádzka %', shortName: '', type: 'percent', valueTypes: ['percent'], mode: 'manual', isDefault: true, isActive: true, formula: [] }
]);

const metricStore = new Map();

const cloneMetric = (metric) => ({
  ...metric,
  valueTypes: normalizeValueTypes(metric.valueTypes || metric.type),
  type: normalizeValueTypes(metric.valueTypes || metric.type)[0],
  formula: Array.isArray(metric.formula) ? JSON.parse(JSON.stringify(metric.formula)) : []
});

const cloneMetrics = (metrics) => metrics.map((metric) => cloneMetric(metric));

let defaultMetricTemplate = cloneMetrics(createDefaultMetrics());

let metricTemplateTableReady = null;

const ensureMetricTemplateTable = async () => {
  if (!metricTemplateTableReady) {
    metricTemplateTableReady = db.query(`
      CREATE TABLE IF NOT EXISTS metric_default_templates (
        owner_key VARCHAR(120) PRIMARY KEY,
        template_json LONGTEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  await metricTemplateTableReady;
};

const loadDefaultTemplateFromDb = async (ownerKey) => {
  try {
    await ensureMetricTemplateTable();
    const [rows] = await db.query(
      'SELECT template_json FROM metric_default_templates WHERE owner_key = ? LIMIT 1',
      [ownerKey]
    );

    const rawTemplate = rows?.[0]?.template_json;
    if (!rawTemplate) return null;

    const parsed = JSON.parse(rawTemplate);
    if (!Array.isArray(parsed)) return null;

    return cloneMetrics(parsed);
  } catch {
    return null;
  }
};

const saveDefaultTemplateToDb = async (ownerKey, metrics) => {
  try {
    await ensureMetricTemplateTable();
    const payload = JSON.stringify(cloneMetrics(metrics));
    await db.query(
      `INSERT INTO metric_default_templates (owner_key, template_json)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE template_json = VALUES(template_json), updated_at = CURRENT_TIMESTAMP`,
      [ownerKey, payload]
    );
  } catch {
    return;
  }
};

const syncDefaultMetricTemplate = (metrics) => {
  defaultMetricTemplate = cloneMetrics(metrics);
};

const getStoreKey = (req) => String(req.user?.id || 'anonymous');

const getMetricsForRequest = async (req) => {
  const key = getStoreKey(req);
  const existing = metricStore.get(key);
  if (existing) {
    syncDefaultMetricTemplate(existing);
    return existing;
  }

  const dbTemplate = await loadDefaultTemplateFromDb(key);
  const defaults = dbTemplate || cloneMetrics(defaultMetricTemplate);
  metricStore.set(key, defaults);
  return defaults;
};

const normalizeMetricType = (value) => {
  const candidate = String(value || '').trim();
  return METRIC_TYPES.has(candidate) ? candidate : 'number';
};

const normalizeMetricMode = (value) => {
  const candidate = String(value || '').trim();
  return METRIC_MODES.has(candidate) ? candidate : 'manual';
};

const sanitizeFormulaNode = (node) => {
  if (!node || typeof node !== 'object') return null;

  if (node.type === 'variable') {
    const metricId = String(node.metricId || '').trim();
    return metricId ? { type: 'variable', metricId } : null;
  }

  if (node.type === 'literal') {
    const value = Number(node.value);
    return Number.isFinite(value) ? { type: 'literal', value } : null;
  }

  if (node.type === 'operator') {
    const op = String(node.op || '').trim();
    return OPS.has(op) ? { type: 'operator', op } : null;
  }

  if (node.type === 'function') {
    const fn = String(node.fn || '').trim();
    if (!FNS.has(fn)) return null;
    const args = Array.isArray(node.args)
      ? node.args.map((arg) => sanitizeFormulaNode(arg)).filter(Boolean)
      : [];
    return { type: 'function', fn, args };
  }

  return null;
};

const sanitizeFormula = (formula) => {
  if (!Array.isArray(formula)) return [];
  return formula.map((node) => sanitizeFormulaNode(node)).filter(Boolean);
};

const collectDependencies = (nodes, out = new Set()) => {
  nodes.forEach((node) => {
    if (node.type === 'variable') {
      out.add(node.metricId);
      return;
    }

    if (node.type === 'function') {
      collectDependencies(node.args || [], out);
    }
  });

  return out;
};

const validateFormulaStructure = (formula) => {
  const errors = [];
  if (formula.length === 0) {
    errors.push({ code: 'EMPTY_FORMULA', message: 'Vzorec je prázdny.' });
    return errors;
  }

  const hasValueNode = formula.some((node) => node.type !== 'operator');
  if (!hasValueNode) {
    errors.push({ code: 'MISSING_VALUE', message: 'Vzorec musí obsahovať aspoň jednu hodnotu.' });
  }

  let expectValue = true;
  let openParens = 0;

  for (const node of formula) {
    if (node.type === 'operator') {
      const op = node.op;

      if (op === '(') {
        if (!expectValue) {
          errors.push({ code: 'INVALID_SEQUENCE', message: 'Pred zátvorkou chýba operátor.' });
          break;
        }
        openParens += 1;
        expectValue = true;
        continue;
      }

      if (op === ')') {
        if (expectValue) {
          errors.push({ code: 'INVALID_SEQUENCE', message: 'Neplatné uzatvorenie zátvorky vo vzorci.' });
          break;
        }
        if (openParens === 0) {
          errors.push({ code: 'UNBALANCED_PARENTHESES', message: 'Vzorec obsahuje nevyvážené zátvorky.' });
          break;
        }
        openParens -= 1;
        expectValue = false;
        continue;
      }

      if (expectValue) {
        errors.push({ code: 'INVALID_SEQUENCE', message: 'Neplatná postupnosť operátorov vo vzorci.' });
        break;
      }
      expectValue = true;
      continue;
    }

    if (!expectValue) {
      errors.push({ code: 'INVALID_SEQUENCE', message: 'Neplatná postupnosť hodnôt vo vzorci.' });
      break;
    }
    expectValue = false;
  }

  if (errors.length === 0 && expectValue) {
    errors.push({ code: 'INVALID_SEQUENCE', message: 'Vzorec končí neplatným operátorom.' });
  }

  if (errors.length === 0 && openParens !== 0) {
    errors.push({ code: 'UNBALANCED_PARENTHESES', message: 'Vzorec obsahuje nevyvážené zátvorky.' });
  }

  return errors;
};

const validateFormulaTypes = (formula, metrics, targetType) => {
  const errors = [];
  const metricsById = new Map(metrics.map((metric) => [metric.id, metric]));

  const dependencies = collectDependencies(formula);
  dependencies.forEach((metricId) => {
    const metric = metricsById.get(metricId);
    if (!metric) {
      errors.push({ code: 'UNKNOWN_VARIABLE', message: `Vzorec odkazuje na neexistujúci ukazovateľ (${metricId}).` });
      return;
    }

    if (!METRIC_TYPES.has(metric.type)) {
      errors.push({ code: 'INVALID_TYPE', message: `Ukazovateľ ${metric.name} má nepodporovaný typ.` });
    }
  });

  if (targetType === 'boolean') {
    errors.push({ code: 'BOOLEAN_RESULT_NOT_SUPPORTED', message: 'Vzorec nie je možné uložiť s výsledným typom boolean.' });
  }

  return errors;
};

const buildDependencyGraph = (metrics) => {
  const graph = new Map();
  metrics.forEach((metric) => {
    const deps = metric.mode === 'formula' ? collectDependencies(metric.formula || []) : new Set();
    graph.set(metric.id, deps);
  });
  return graph;
};

const hasCycleFrom = (graph, startId) => {
  const visited = new Set();
  const stack = new Set();

  const dfs = (nodeId) => {
    if (stack.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;

    visited.add(nodeId);
    stack.add(nodeId);

    const deps = graph.get(nodeId) || new Set();
    for (const depId of deps) {
      if (graph.has(depId) && dfs(depId)) {
        return true;
      }
    }

    stack.delete(nodeId);
    return false;
  };

  return dfs(startId);
};

router.get('/metrics', authenticateToken, async (req, res) => {
  const metrics = await getMetricsForRequest(req);
  res.status(200).json({ total: metrics.length, metrics: metrics.map(cloneMetric) });
});

router.post('/metrics/validate-formula', authenticateToken, async (req, res) => {
  const metrics = await getMetricsForRequest(req);
  const formula = sanitizeFormula(req.body?.formula);
  const metricId = req.body?.metricId ? String(req.body.metricId) : '';
  const targetType = normalizeValueTypes(req.body?.valueTypes || req.body?.type)[0];

  const errors = [
    ...validateFormulaStructure(formula),
    ...validateFormulaTypes(formula, metrics, targetType)
  ];

  if (metricId) {
    const graph = buildDependencyGraph(metrics.map((metric) => (
      metric.id === metricId ? { ...metric, mode: 'formula', formula } : metric
    )));
    if (hasCycleFrom(graph, metricId)) {
      errors.push({ code: 'CYCLE_DETECTED', message: 'Vzorec obsahuje cyklický odkaz.' });
    }
  }

  res.status(200).json({ valid: errors.length === 0, errors });
});

router.post('/metrics', authenticateToken, async (req, res) => {
  const metrics = await getMetricsForRequest(req);
  const name = String(req.body?.name || '').trim();

  if (!name) {
    res.status(400).json({ error: 'validation_error', message: 'Názov ukazovateľa je povinný.' });
    return;
  }

  const duplicate = metrics.some((metric) => metric.name.trim().toLowerCase() === name.toLowerCase());
  if (duplicate) {
    res.status(409).json({ error: 'duplicate_metric_name', message: 'Ukazovateľ s týmto názvom už existuje.' });
    return;
  }

  const valueTypes = normalizeValueTypes(req.body?.valueTypes || req.body?.type);
  const type = valueTypes[0] || normalizeMetricType(req.body?.type);
  const shortName = String(req.body?.shortName || '').trim();
  const mode = normalizeMetricMode(req.body?.mode);
  const formula = mode === 'formula' ? sanitizeFormula(req.body?.formula) : [];

  if (mode === 'formula') {
    const errors = [...validateFormulaStructure(formula), ...validateFormulaTypes(formula, metrics, type)];
    if (errors.length > 0) {
      res.status(400).json({ error: 'invalid_formula', message: 'Vzorec nie je validný.', errors });
      return;
    }
  }

  const created = {
    id: `custom-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    name,
    shortName,
    type,
    valueTypes,
    mode,
    isDefault: false,
    isActive: req.body?.isActive !== false,
    formula
  };

  const nextMetrics = [...metrics, created];
  metricStore.set(getStoreKey(req), nextMetrics);
  syncDefaultMetricTemplate(nextMetrics);
  await saveDefaultTemplateToDb(getStoreKey(req), nextMetrics);
  res.status(201).json({ message: 'Ukazovateľ bol vytvorený.', metric: cloneMetric(created) });
});

router.put('/metrics/:id', authenticateToken, async (req, res) => {
  const metrics = await getMetricsForRequest(req);
  const metricId = String(req.params.id || '').trim();
  const metric = metrics.find((item) => item.id === metricId);

  if (!metric) {
    res.status(404).json({ error: 'metric_not_found', message: 'Ukazovateľ neexistuje.' });
    return;
  }

  const name = String(req.body?.name ?? metric.name).trim();
  const shortName = String(req.body?.shortName ?? metric.shortName ?? '').trim();
  if (!name) {
    res.status(400).json({ error: 'validation_error', message: 'Názov ukazovateľa je povinný.' });
    return;
  }

  const duplicate = metrics.some((item) => item.id !== metricId && item.name.trim().toLowerCase() === name.toLowerCase());
  if (duplicate) {
    res.status(409).json({ error: 'duplicate_metric_name', message: 'Ukazovateľ s týmto názvom už existuje.' });
    return;
  }

  const type = normalizeMetricType(req.body?.type ?? metric.type);
  const valueTypes = normalizeValueTypes(req.body?.valueTypes || req.body?.type || metric.valueTypes || metric.type);
  const mode = normalizeMetricMode(req.body?.mode ?? metric.mode);
  const formula = mode === 'formula' ? sanitizeFormula(req.body?.formula ?? metric.formula) : [];

  if (mode === 'formula') {
    const localErrors = [...validateFormulaStructure(formula), ...validateFormulaTypes(formula, metrics, type)];
    const graph = buildDependencyGraph(metrics.map((item) => (
      item.id === metricId ? { ...item, mode: 'formula', formula } : item
    )));

    if (hasCycleFrom(graph, metricId)) {
      localErrors.push({ code: 'CYCLE_DETECTED', message: 'Vzorec obsahuje cyklický odkaz.' });
    }

    if (localErrors.length > 0) {
      res.status(400).json({ error: 'invalid_formula', message: 'Vzorec nie je validný.', errors: localErrors });
      return;
    }
  }

  const updated = {
    ...metric,
    name,
    shortName,
    type: valueTypes[0] || type,
    valueTypes,
    mode,
    isActive: req.body?.isActive === undefined ? metric.isActive : Boolean(req.body.isActive),
    formula
  };

  const nextMetrics = metrics.map((item) => (item.id === metricId ? updated : item));
  metricStore.set(getStoreKey(req), nextMetrics);
  syncDefaultMetricTemplate(nextMetrics);
  await saveDefaultTemplateToDb(getStoreKey(req), nextMetrics);

  res.status(200).json({ message: 'Ukazovateľ bol upravený.', metric: cloneMetric(updated) });
});

router.delete('/metrics/:id', authenticateToken, async (req, res) => {
  const metrics = await getMetricsForRequest(req);
  const metricId = String(req.params.id || '').trim();
  const metric = metrics.find((item) => item.id === metricId);

  if (!metric) {
    res.status(404).json({ error: 'metric_not_found', message: 'Ukazovateľ neexistuje.' });
    return;
  }

  if (metric.isDefault) {
    res.status(400).json({ error: 'default_metric_cannot_be_deleted', message: 'Preddefinovaný ukazovateľ nie je možné odstrániť.' });
    return;
  }

  const blocking = metrics
    .filter((item) => item.id !== metricId && item.mode === 'formula')
    .filter((item) => collectDependencies(item.formula || []).has(metricId));

  if (blocking.length > 0) {
    res.status(409).json({
      error: 'metric_used_in_formula',
      message: 'Ukazovateľ je použitý v inom vzorci.',
      usedBy: blocking.map((item) => ({ id: item.id, name: item.name }))
    });
    return;
  }

  const nextMetrics = metrics.filter((item) => item.id !== metricId);
  metricStore.set(getStoreKey(req), nextMetrics);
  syncDefaultMetricTemplate(nextMetrics);
  await saveDefaultTemplateToDb(getStoreKey(req), nextMetrics);

  res.status(200).json({ message: 'Ukazovateľ bol odstránený.' });
});

module.exports = router;