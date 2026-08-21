import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

//#region src/data.ts
function extension$1(path) {
	return path.match(/\.[^.\\/]+$/)?.[0].toLowerCase() ?? "";
}
function coerce(value) {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	const number = Number(trimmed);
	if (Number.isFinite(number) && /^[-+]?\d+(\.\d+)?$/.test(trimmed)) return number;
	return trimmed;
}
function parseDelimited(text$1, delimiter) {
	const rows = [];
	let row = [];
	let cell = "";
	let quoted = false;
	for (let index = 0; index < text$1.length; index += 1) {
		const char = text$1[index];
		const next = text$1[index + 1];
		if (char === "\"") if (quoted && next === "\"") {
			cell += "\"";
			index += 1;
		} else quoted = !quoted;
		else if (char === delimiter && !quoted) {
			row.push(cell);
			cell = "";
		} else if ((char === "\n" || char === "\r") && !quoted) {
			if (char === "\r" && next === "\n") index += 1;
			row.push(cell);
			cell = "";
			if (row.some((value) => value.trim())) rows.push(row);
			row = [];
		} else cell += char;
	}
	row.push(cell);
	if (row.some((value) => value.trim())) rows.push(row);
	return rows;
}
function objectRows(value) {
	if (Array.isArray(value)) return value;
	if (typeof value === "object" && value !== null && Array.isArray(value.rows)) return value.rows;
	throw new Error("JSON source must be an array or an object with a rows array");
}
function normalizeRow(value, index) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`row ${index + 1} must be an object`);
	const row = {};
	for (const [key, cell] of Object.entries(value)) if (cell === null || typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean") row[key] = cell;
	else if (cell === void 0) row[key] = void 0;
	else row[key] = JSON.stringify(cell);
	return row;
}
async function readSalesDataset(fs, config, path, signal) {
	const target = await fs.resolve(path, { signal });
	const info = await fs.stat(target, signal);
	if (!info || info.type !== "file") throw new Error(`Sales data file not found: ${path}`);
	if ((info.size ?? 0) > config.maxFileBytes) throw new Error(`File exceeds maxFileBytes (${config.maxFileBytes})`);
	const text$1 = await fs.readText(target, signal);
	if (text$1.length > config.maxTextChars) throw new Error(`File exceeds maxTextChars (${config.maxTextChars})`);
	const ext = extension$1(path);
	let rows;
	const warnings = [];
	if (ext === ".csv" || ext === ".tsv") {
		const table = parseDelimited(text$1, ext === ".tsv" ? "	" : ",");
		const headers = (table.shift() ?? []).map((header, index) => header.trim() || `column_${index + 1}`);
		rows = table.slice(0, config.maxRows).map((cells) => Object.fromEntries(headers.map((header, index) => [header, coerce(cells[index] ?? "")])));
		if (table.length > config.maxRows) warnings.push(`Rows truncated at maxRows (${config.maxRows})`);
	} else if (ext === ".jsonl" || ext === ".ndjson") rows = text$1.split(/\r?\n/).filter((line) => line.trim()).slice(0, config.maxRows).map((line, index) => normalizeRow(JSON.parse(line), index));
	else if (ext === ".json") rows = objectRows(JSON.parse(text$1)).slice(0, config.maxRows).map(normalizeRow);
	else throw new Error(`Unsupported sales dataset extension: ${ext || "unknown"}`);
	const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
	if (rows.length === 0) warnings.push("Dataset contains no rows");
	return {
		source: path,
		rows,
		columns,
		warnings
	};
}
function valueString(value) {
	return value === null || value === void 0 ? "" : String(value);
}
function numberValue(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value.replace(/[,￥¥$€\s]/g, ""));
		if (Number.isFinite(parsed)) return parsed;
	}
}
function findField(columns, preferred, candidates) {
	if (preferred && columns.includes(preferred)) return preferred;
	const lowered = columns.map((column) => ({
		column,
		lower: column.toLowerCase()
	}));
	return candidates.map((candidate) => candidate.toLowerCase()).flatMap((candidate) => lowered.filter((item) => item.lower === candidate || item.lower.includes(candidate)).map((item) => item.column))[0];
}

//#endregion
//#region src/output.ts
const resultSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		schemaVersion: { type: "string" },
		ok: { type: "boolean" },
		data: { type: "json" },
		warnings: {
			type: "array",
			items: { type: "string" }
		},
		assumptions: {
			type: "array",
			items: { type: "string" }
		},
		lineage: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: true
			}
		},
		nextActions: {
			type: "array",
			items: { type: "string" }
		}
	}
};
function jsonValue(value) {
	return JSON.parse(JSON.stringify(value));
}
function resultEnvelope(options) {
	return {
		schemaVersion: "1.0",
		ok: true,
		data: options.data,
		warnings: [...options.warnings ?? []],
		assumptions: [...options.assumptions ?? []],
		lineage: [...options.lineage ?? []],
		nextActions: [...options.nextActions ?? []]
	};
}
function renderResult(value, maxChars) {
	const text$1 = JSON.stringify(value, null, 2);
	return [{
		type: "text",
		text: text$1.length > maxChars ? `${text$1.slice(0, maxChars)}\n... result truncated by dsh-sales; use a narrower source or scope ...` : text$1
	}];
}

//#endregion
//#region src/markdown.ts
function scalar(value) {
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (trimmed.startsWith("\"") && trimmed.endsWith("\"") || trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	const number = Number(trimmed);
	return Number.isFinite(number) && /^[-+]?\d+(\.\d+)?$/.test(trimmed) ? number : trimmed;
}
function parseNote(path, content) {
	const lines = content.split(/\r?\n/);
	const frontmatter = {};
	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
		if (end > 0) for (const line of lines.slice(1, end)) {
			const separator = line.indexOf(":");
			if (separator > 0) frontmatter[line.slice(0, separator).trim()] = scalar(line.slice(separator + 1));
		}
	}
	const headings = lines.filter((line) => /^#{1,6}\s+/.test(line)).map((line) => line.replace(/^#{1,6}\s+/, "").trim());
	return {
		path,
		title: headings[0] ?? String(frontmatter.title ?? path.split(/[\\/]/).pop() ?? "Sales note"),
		content,
		frontmatter,
		headings,
		externalLinks: [...content.matchAll(/https?:\/\/[^\s)]+/g)].map((match) => match[0]),
		wordCount: content.trim().split(/\s+/).filter(Boolean).length
	};
}
function artifactHeader(type, title, status, fields = {}) {
	const lines = [
		"---",
		`artifact: ${type}`,
		`status: ${status}`
	];
	for (const [key, value] of Object.entries(fields)) if (value) lines.push(`${key}: ${value}`);
	lines.push("---", "", `# ${title}`, "");
	return lines.join("\n");
}
function replacementDiff(before, after) {
	const left = before.split(/\r?\n/);
	const right = after.split(/\r?\n/);
	const preview = [];
	let changedLines = 0;
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		if (left[index] === right[index]) continue;
		changedLines += 1;
		if (preview.length < 20) {
			if (left[index] !== void 0) preview.push(`- ${left[index]}`);
			if (right[index] !== void 0) preview.push(`+ ${right[index]}`);
		}
	}
	return {
		beforeLines: left.length,
		afterLines: right.length,
		changedLines,
		preview
	};
}

//#endregion
//#region src/sales.ts
const stageOrder = [
	"lead",
	"qualified",
	"discovery",
	"solution",
	"proposal",
	"negotiation",
	"closed-won",
	"closed-lost",
	"renewal",
	"expansion"
];
const stageProbabilities = {
	lead: .05,
	qualified: .15,
	discovery: .25,
	solution: .4,
	proposal: .6,
	negotiation: .8,
	"closed-won": 1,
	"closed-lost": 0,
	renewal: .75,
	expansion: .65
};
const aliases = {
	线索: "lead",
	leads: "lead",
	lead: "lead",
	mql: "qualified",
	sql: "qualified",
	资格: "qualified",
	qualified: "qualified",
	discovery: "discovery",
	需求沟通: "discovery",
	需求: "discovery",
	solution: "solution",
	方案: "solution",
	demo: "solution",
	演示: "solution",
	proposal: "proposal",
	报价: "proposal",
	提案: "proposal",
	negotiation: "negotiation",
	谈判: "negotiation",
	商务: "negotiation",
	"closed-won": "closed-won",
	won: "closed-won",
	赢单: "closed-won",
	成交: "closed-won",
	"closed-lost": "closed-lost",
	lost: "closed-lost",
	输单: "closed-lost",
	失单: "closed-lost",
	renewal: "renewal",
	续费: "renewal",
	expansion: "expansion",
	扩单: "expansion",
	增购: "expansion"
};
function text(value) {
	return typeof value === "string" ? value.trim() : value === void 0 || value === null ? "" : String(value).trim();
}
function normalizeStage(value) {
	const key = text(value).toLowerCase();
	return aliases[key] ?? (key.replace(/\s+/g, "-") || "unknown");
}
function percent(value) {
	return Math.round(value * 1e3) / 10;
}
function amountFromRow(row, field$1) {
	return field$1 ? numberValue(row[field$1]) ?? 0 : 0;
}
function analyzeSalesFunnel(dataset, options = {}) {
	const stageField = findField(dataset.columns, options.stageField, [
		"stage",
		"status",
		"opportunity_stage",
		"阶段",
		"商机阶段",
		"状态"
	]);
	const amountField = findField(dataset.columns, options.amountField, [
		"amount",
		"value",
		"revenue",
		"deal_value",
		"金额",
		"合同金额",
		"收入"
	]);
	const dateField = findField(dataset.columns, options.dateField, [
		"close_date",
		"expected_close",
		"date",
		"预计成交日",
		"成交日期"
	]);
	if (!stageField) throw new Error("Could not identify a stage field; provide stageField explicitly");
	const customProbabilities = options.probabilityJson ? JSON.parse(options.probabilityJson) : {};
	const grouped = /* @__PURE__ */ new Map();
	for (const row of dataset.rows) {
		const stage = normalizeStage(row[stageField]);
		const current = grouped.get(stage) ?? {
			records: 0,
			amount: 0
		};
		current.records += 1;
		current.amount += amountFromRow(row, amountField);
		grouped.set(stage, current);
	}
	const order = [...new Set([...stageOrder, ...grouped.keys()])].filter((stage) => grouped.has(stage));
	const totalAmount = [...grouped.values()].reduce((sum, item) => sum + item.amount, 0);
	const stages = order.map((stage, index) => {
		const current = grouped.get(stage) ?? {
			records: 0,
			amount: 0
		};
		const previous = index > 0 ? grouped.get(order[index - 1] ?? "")?.records ?? 0 : 0;
		const probability = customProbabilities[stage] ?? stageProbabilities[stage] ?? .2;
		return {
			stage,
			records: current.records,
			amount: Math.round(current.amount * 100) / 100,
			conversionFromPrevious: index === 0 || previous === 0 ? null : percent(current.records / previous),
			shareOfPipeline: totalAmount === 0 ? null : percent(current.amount / totalAmount),
			probability
		};
	});
	const weightedAmount = stages.reduce((sum, stage) => sum + stage.amount * stage.probability, 0);
	const missing = [];
	if (!amountField) missing.push("amount field");
	if (!dateField) missing.push("close date field");
	if (dataset.rows.some((row) => !text(row[stageField]))) missing.push("rows with missing stage");
	const warnings = [...dataset.warnings];
	if (stages.some((stage) => stage.stage === "unknown")) warnings.push("Some stage values could not be mapped to the standard stage taxonomy");
	return {
		source: dataset.source,
		stageField,
		...amountField ? { amountField } : {},
		...dateField ? { dateField } : {},
		stages: stages.map(({ probability: _probability, ...stage }) => stage),
		totals: {
			records: dataset.rows.length,
			amount: Math.round(totalAmount * 100) / 100,
			weightedAmount: Math.round(weightedAmount * 100) / 100
		},
		missing,
		warnings,
		nextActions: missing.length > 0 ? [`补齐 ${missing.join("、")} 后再使用销售管道做决策。`] : ["按 Owner、来源和预计成交窗口切分，定位阶段停留和客户动作缺口。"]
	};
}
function factStatus(value) {
	if (typeof value !== "object" || value === null) return text(value) ? "inferred" : "missing";
	const status = text(value.status);
	return [
		"observed",
		"customer-stated",
		"estimated",
		"inferred",
		"missing"
	].includes(status) ? status : text(value.value) ? "inferred" : "missing";
}
function factValue(value) {
	if (typeof value === "object" && value !== null && "value" in value) return text(value.value);
	return text(value);
}
function factSource(value) {
	if (typeof value === "object" && value !== null && "source" in value) return text(value.source) || void 0;
}
function listField(value) {
	if (!Array.isArray(value)) return [];
	return value.map((item) => text(item)).filter(Boolean);
}
function reviewProductSalesHandoff(input) {
	const handoff = input;
	const missing = [];
	const risks = [];
	if (handoff.artifactType !== "product-sales-handoff") risks.push("交接 artifactType 不是 product-sales-handoff，不能按产品销售交接处理。");
	if (handoff.handoffFrom !== "dsh-product" || handoff.handoffTo !== "dsh-sales") risks.push("交接来源或目标不正确，避免把其他阶段材料直接当成销售交接。");
	if (handoff.schemaVersion !== "1.0") missing.push("schemaVersion must be 1.0");
	if (!text(handoff.artifactId)) missing.push("artifactId");
	for (const [field$1, value] of [
		["handoffVersion", handoff.handoffVersion],
		["productDecision", handoff.productDecision],
		["productName", handoff.productName],
		["targetBuyer", handoff.targetBuyer],
		["customerProblem", handoff.customerProblem],
		["desiredOutcome", handoff.desiredOutcome],
		["nextCustomerAction", handoff.nextCustomerAction]
	]) if (!text(value)) missing.push(field$1);
	if (!["proceed", "scale"].includes(text(handoff.productDecision))) missing.push("productDecision must be proceed or scale");
	if (listField(handoff.valueEvidence).length === 0) missing.push("valueEvidence");
	if (listField(handoff.proofPoints).length === 0) missing.push("proofPoints");
	if (listField(handoff.commercialContext).length === 0) missing.push("commercialContext from dsh-business or user");
	if (!text(handoff.source)) risks.push("没有来源路径；销售团队无法回到产品决策或 PMF 证据。");
	if (listField(handoff.commercialQuestions).length > 0) risks.push(`仍有 ${listField(handoff.commercialQuestions).length} 个商业问题待确认，不能直接承诺价格或折扣。`);
	const status = risks.some((risk) => risk.includes("不是 product-sales-handoff") || risk.includes("来源或目标不正确")) ? "blocked" : missing.length === 0 && risks.length === 0 ? "ready" : missing.length <= 3 ? "partial" : "blocked";
	const decision = status === "ready" ? "advance" : status === "partial" ? "validate" : "hold";
	const nextActions = status === "ready" ? ["运行 sales_deal_review，补齐客户 Problem、Impact、Buyer、Process、Timing、Competition 和 Commitment。", "确认 dsh-business 的价格底线、成本基础、付款和折扣授权后再进入报价审查。"] : ["先补齐销售交接缺失字段和商业问题，再运行 sales_deal_review；不要用缺失字段推断成交概率。"];
	const normalized = {
		...handoff,
		valueEvidence: listField(handoff.valueEvidence),
		proofPoints: listField(handoff.proofPoints),
		requiredCapabilities: listField(handoff.requiredCapabilities),
		implementationConstraints: listField(handoff.implementationConstraints),
		commercialContext: listField(handoff.commercialContext),
		commercialQuestions: listField(handoff.commercialQuestions)
	};
	const productName = text(handoff.productName) || "未命名产品";
	const markdown = [
		artifactHeader("sales-handoff-review", `${productName} 产品销售交接审查`, status, { source: text(handoff.source) }),
		"## 交接判断",
		"",
		`- 决定：${decision}`,
		`- 准备度：${status}`,
		`- 产品决策：${text(handoff.productDecision) || "缺失"}`,
		"",
		"## 缺失字段",
		...missing.length > 0 ? missing.map((item) => `- ${item}`) : ["- 无"],
		"",
		"## 风险",
		...risks.length > 0 ? risks.map((item) => `- ${item}`) : ["- 未发现阻塞风险"],
		"",
		"## 下一步",
		...nextActions.map((item) => `- ${item}`),
		""
	].join("\n");
	return {
		artifactType: "sales-handoff-review",
		source: text(handoff.source) || void 0,
		productName,
		status,
		decision,
		missing,
		risks,
		handoff: normalized,
		warnings: [],
		nextActions,
		markdown
	};
}
function reviewCommercialHandoff(input) {
	const handoff = input;
	const missing = [];
	const risks = [...Array.isArray(handoff.risks) ? handoff.risks.map((item) => text(item)).filter(Boolean) : []];
	if (handoff.artifactType !== "commercial-handoff") risks.push("交接 artifactType 不是 commercial-handoff。");
	if (handoff.handoffFrom !== "dsh-business" || handoff.handoffTo !== "dsh-sales") risks.push("商业交接来源或目标不正确。");
	if (handoff.schemaVersion !== "1.0") missing.push("schemaVersion must be 1.0");
	if (!text(handoff.artifactId)) missing.push("artifactId");
	for (const [field$1, value] of [
		["handoffVersion", handoff.handoffVersion],
		["productName", handoff.productName],
		["currency", handoff.currency],
		["decision", handoff.decision]
	]) if (!text(value)) missing.push(field$1);
	if (handoff.decision !== "review") missing.push("decision must be review");
	if (!Array.isArray(handoff.offers) || handoff.offers.length === 0) missing.push("offers");
	if (!Array.isArray(handoff.requiredApprovals) || handoff.requiredApprovals.length === 0) missing.push("requiredApprovals");
	const offers = Array.isArray(handoff.offers) ? handoff.offers : [];
	for (const offer of offers) {
		if (typeof offer !== "object" || offer === null) {
			risks.push("存在无法解析的报价行。");
			continue;
		}
		const row = offer;
		if (row.minimumTransactionPrice === void 0) missing.push(`minimumTransactionPrice: ${text(row.sku)}/${text(row.channel)}`);
		if (typeof row.contributionPerUnit === "number" && row.contributionPerUnit < 0) risks.push(`${text(row.sku)}/${text(row.channel)} 单位贡献为负，不能进入正常报价。`);
		if (row.status === "blocked") risks.push(`${text(row.sku)}/${text(row.channel)} 报价状态为 blocked。`);
	}
	if (!text(handoff.source)) risks.push("没有商业分析来源；无法回到价格或成本计算。");
	const status = risks.some((risk) => risk.includes("不是 commercial-handoff") || risk.includes("来源或目标不正确") || risk.includes("单位贡献为负") || risk.includes("状态为 blocked")) ? "blocked" : missing.length === 0 ? "ready" : missing.length <= 2 ? "partial" : "blocked";
	const decision = status === "ready" ? "advance" : status === "partial" ? "validate" : "hold";
	const nextActions = status === "ready" ? ["由授权负责人确认商业交接，再运行 sales_offer_review 审查客户价值、付款和折扣条件。", "任何例外价格或折扣都要回到 dsh-business 或授权审批流程。"] : ["先补齐明确最低成交价、报价来源、审批人和风险处置，不要把有效成交价当成授权底线。"];
	const normalized = {
		...handoff,
		offers: offers.filter((offer) => typeof offer === "object" && offer !== null),
		risks,
		requiredApprovals: Array.isArray(handoff.requiredApprovals) ? handoff.requiredApprovals.map((item) => text(item)).filter(Boolean) : []
	};
	const productName = text(handoff.productName) || "未命名产品";
	const markdown = [
		artifactHeader("commercial-handoff-review", `${productName} 商业交接审查`, status, { source: text(handoff.source) }),
		"## 交接判断",
		"",
		`- 决定：${decision}`,
		`- 准备度：${status}`,
		`- 商业决定：${text(handoff.decision) || "缺失"}`,
		"",
		"## 缺失字段",
		...missing.length > 0 ? missing.map((item) => `- ${item}`) : ["- 无"],
		"",
		"## 风险",
		...risks.length > 0 ? risks.map((item) => `- ${item}`) : ["- 未发现阻塞风险"],
		"",
		"## 下一步",
		...nextActions.map((item) => `- ${item}`),
		""
	].join("\n");
	return {
		artifactType: "commercial-handoff-review",
		source: text(handoff.source) || void 0,
		productName,
		status,
		decision,
		missing,
		risks,
		handoff: normalized,
		warnings: [],
		nextActions,
		markdown
	};
}
function reviewMarkdown(result) {
	const lines = [
		artifactHeader("deal-review", `${result.deal} 商机复盘`, result.readiness === "ready" ? "ready-for-review" : "draft", {
			deal: result.deal,
			decision: result.decision
		}),
		"## 结论",
		"",
		`- 判断：${result.decision}`,
		`- 准备度：${result.readiness}`,
		`- 评分：${result.score}%`,
		"",
		"## 资格证据",
		"",
		"| 维度 | 状态 | 证据 | 来源 |",
		"| --- | --- | --- | --- |"
	];
	for (const item of result.evidence) lines.push(`| ${item.dimension} | ${item.status} | ${item.value || "缺失"} | ${item.source ?? ""} |`);
	lines.push("", "## 风险与缺口", "", ...result.risks.length > 0 ? result.risks.map((item) => `- ${item}`) : ["- 未识别到额外风险"], "", "## 下一步", "", ...result.nextActions.map((item) => `- ${item}`));
	return lines.join("\n");
}
function reviewDeal(deal, facts, source) {
	const dimensions = [
		"problem",
		"impact",
		"buyer",
		"process",
		"timing",
		"competition",
		"commitment"
	];
	const labels = {
		problem: "Problem",
		impact: "Impact",
		buyer: "Buyer",
		process: "Process",
		timing: "Timing",
		competition: "Competition",
		commitment: "Commitment"
	};
	const evidence = dimensions.map((dimension) => {
		const evidenceSource = factSource(facts[dimension]) ?? source;
		return {
			dimension: labels[dimension] ?? dimension,
			status: factStatus(facts[dimension]),
			value: factValue(facts[dimension]),
			...evidenceSource ? { source: evidenceSource } : {}
		};
	});
	const strong = evidence.filter((item) => item.status === "observed" || item.status === "customer-stated").length;
	const missing = evidence.filter((item) => item.status === "missing" || !item.value).map((item) => item.dimension);
	const risks = [];
	if (evidence.find((item) => item.dimension === "Commitment")?.status === "missing") risks.push("没有客户可验证动作，当前可能只是兴趣而不是机会");
	if (evidence.find((item) => item.dimension === "Buyer")?.status === "missing") risks.push("决策人、经济买方或批准路径不清楚");
	if (evidence.find((item) => item.dimension === "Impact")?.status === "missing") risks.push("价值没有连接到基线、金额、时间或风险结果");
	if (evidence.find((item) => item.dimension === "Process")?.status === "missing") risks.push("采购、技术、法务或上线流程未知");
	const score = percent(strong / dimensions.length);
	const readiness = missing.length === 0 && strong >= 5 ? "ready" : strong >= 3 ? "partial" : "blocked";
	const base = {
		deal,
		decision: readiness === "ready" ? "advance" : readiness === "partial" ? "validate" : "hold",
		readiness,
		score,
		evidence,
		missing,
		risks,
		nextActions: missing.length > 0 ? missing.slice(0, 3).map((item) => `补齐 ${item}：让客户或内部 Owner 给出可引用证据、负责人和日期`) : ["确认客户下一步动作、完成日期和验收证据", "核对报价、成本、付款和折扣授权，再进入商业审查"],
		assumptions: ["评分只表示证据覆盖率，不是成交概率", "未提供的字段保持缺失，不自动视为否定或通过"]
	};
	return {
		...base,
		markdown: reviewMarkdown(base)
	};
}
function reviewOffer(offer, input) {
	const fields = [
		"targetCustomer",
		"problem",
		"desiredOutcome",
		"priceSource",
		"costBasis",
		"discountAuthority",
		"paymentTerms"
	];
	const labels = {
		targetCustomer: "目标客户",
		problem: "客户问题",
		desiredOutcome: "期望结果",
		priceSource: "报价来源",
		costBasis: "成本基础",
		discountAuthority: "折扣授权",
		paymentTerms: "付款条款"
	};
	const commercialFacts = fields.map((field$1) => ({
		field: labels[field$1] ?? field$1,
		status: factStatus(input.facts[field$1]),
		value: factValue(input.facts[field$1])
	}));
	const missing = commercialFacts.filter((fact) => fact.status === "missing" || !fact.value).map((fact) => fact.field);
	const risks = [];
	if (missing.includes("报价来源")) risks.push("报价没有可核验来源，不能判断是否符合价格政策");
	if (missing.includes("成本基础")) risks.push("缺少成本或贡献毛利基础，不能判断让利风险");
	if (missing.includes("折扣授权")) risks.push("折扣权限不清，不能把降价写进承诺");
	if ((input.valueEvidence ?? []).length === 0) risks.push("没有价值证据，价格只能被客户当成成本比较");
	const readiness = missing.length === 0 && risks.length === 0 ? "ready" : missing.length <= 2 ? "partial" : "blocked";
	const decision = readiness === "ready" ? "approve-for-review" : readiness === "partial" ? "revise" : "blocked";
	const nextActions = missing.length > 0 ? [`补齐：${missing.slice(0, 4).join("、")}`] : ["让客户确认结果、范围、时间和验收方式，再进入正式报价审批"];
	const lines = [
		artifactHeader("offer-review", `${offer} 报价与变现审查`, readiness === "ready" ? "ready-for-review" : "draft"),
		"## 价值证据",
		"",
		...input.valueEvidence?.length ? input.valueEvidence.map((item) => `- ${item}`) : ["- 缺失"],
		"",
		"## 商业事实",
		"",
		"| 字段 | 状态 | 值 |",
		"| --- | --- | --- |",
		...commercialFacts.map((fact) => `| ${fact.field} | ${fact.status} | ${fact.value || "缺失"} |`),
		"",
		"## 风险",
		"",
		...risks.length ? risks.map((risk) => `- ${risk}`) : ["- 未发现阻塞风险"],
		"",
		"## 下一步",
		"",
		...nextActions.map((action) => `- ${action}`)
	];
	return {
		offer,
		decision,
		readiness,
		valueEvidence: input.valueEvidence ?? [],
		commercialFacts,
		risks,
		missing,
		nextActions,
		markdown: lines.join("\n")
	};
}
function forecastPipeline(dataset, options) {
	const stageField = findField(dataset.columns, options.stageField, [
		"stage",
		"status",
		"opportunity_stage",
		"阶段",
		"商机阶段",
		"状态"
	]);
	const amountField = findField(dataset.columns, options.amountField, [
		"amount",
		"value",
		"revenue",
		"deal_value",
		"金额",
		"合同金额",
		"收入"
	]);
	const closeDateField = findField(dataset.columns, options.closeDateField, [
		"close_date",
		"expected_close",
		"预计成交日",
		"成交日期"
	]);
	if (!stageField) throw new Error("Could not identify a stage field; provide stageField explicitly");
	const custom = options.probabilityJson ? JSON.parse(options.probabilityJson) : {};
	const asOf = options.asOf ? new Date(options.asOf) : /* @__PURE__ */ new Date();
	if (Number.isNaN(asOf.getTime())) throw new Error(`Invalid asOf date: ${options.asOf}`);
	const grouped = /* @__PURE__ */ new Map();
	let rawAmount = 0;
	let weightedAmount = 0;
	let missingAmount = 0;
	let missingCloseDate = 0;
	let staleRecords = 0;
	for (const row of dataset.rows) {
		const stage = normalizeStage(row[stageField]);
		const amount = amountField ? numberValue(row[amountField]) : void 0;
		const probability = custom[stage] ?? stageProbabilities[stage] ?? .2;
		if (amount === void 0) missingAmount += 1;
		else {
			rawAmount += amount;
			weightedAmount += amount * probability;
		}
		const closeDate = closeDateField ? new Date(valueString(row[closeDateField])) : void 0;
		if (!closeDateField || !valueString(row[closeDateField]) || Number.isNaN(closeDate?.getTime())) missingCloseDate += 1;
		else if (closeDate && closeDate < asOf && !["closed-won", "closed-lost"].includes(stage)) staleRecords += 1;
		const current = grouped.get(stage) ?? {
			records: 0,
			amount: 0
		};
		current.records += 1;
		current.amount += amount ?? 0;
		grouped.set(stage, current);
	}
	const byStage = [...grouped.entries()].map(([stage, value]) => {
		const probability = custom[stage] ?? stageProbabilities[stage] ?? .2;
		return {
			stage,
			records: value.records,
			amount: Math.round(value.amount * 100) / 100,
			probability,
			weightedAmount: Math.round(value.amount * probability * 100) / 100
		};
	}).sort((a, b) => stageOrder.indexOf(a.stage) - stageOrder.indexOf(b.stage));
	const warnings = [...dataset.warnings];
	if (!amountField) warnings.push("No amount field detected; forecast amounts are zero");
	if (staleRecords > 0) warnings.push(`${staleRecords} open records have a close date before asOf`);
	return {
		source: dataset.source,
		currency: options.currency,
		asOf: asOf.toISOString(),
		records: dataset.rows.length,
		rawAmount: Math.round(rawAmount * 100) / 100,
		weightedAmount: Math.round(weightedAmount * 100) / 100,
		byStage,
		missingAmount,
		missingCloseDate,
		staleRecords,
		warnings,
		assumptions: ["Weighted forecast equals amount × stage probability; it is not a revenue commitment", "Probabilities are heuristic defaults unless probabilityJson or historical conversion evidence is supplied"],
		nextActions: missingAmount > 0 || missingCloseDate > 0 ? ["先清理金额、预计成交日和阶段退出条件，再使用预测做资源决策。"] : ["按 Owner、客户分群和成交窗口复核加权管道，标出需要客户承诺的机会。"]
	};
}
function generatePlaybook(input) {
	const lines = [
		artifactHeader("sales-playbook", input.title, "draft", { source: input.source }),
		"## 目标客户与销售动作",
		"",
		`- 目标客户：${input.targetCustomer}`,
		`- 销售动作：${input.salesMotion}`,
		`- 价值主张：${input.valueProposition}`,
		"",
		"## 发现问题",
		"",
		...input.discoveryQuestions.map((item, index) => `${index + 1}. ${item}`),
		"",
		"## 资格判断",
		"",
		...input.qualificationCriteria.map((item) => `- ${item}`),
		"",
		"## 异议处理原则",
		"",
		...input.objections.length ? input.objections.map((item) => `- ${item}`) : ["- 先确认问题、影响和决策条件，不直接承诺折扣"],
		"",
		"## 下一客户动作",
		"",
		`- ${input.nextStep}`,
		"",
		"## 证据纪律",
		"",
		"- 客户原话、内部判断和待验证假设分开记录。",
		"- 报价、折扣、交付和日期承诺必须引用来源并经过授权。"
	];
	return {
		artifactType: "sales-playbook",
		title: input.title,
		status: "draft",
		...input.source ? { source: input.source } : {},
		markdown: lines.join("\n"),
		nextActions: ["补充来源、Owner、更新时间和验收标准后再作为团队标准。"]
	};
}
function stale(updated) {
	if (!updated) return true;
	const date = new Date(String(updated));
	return Number.isNaN(date.getTime()) || Date.now() - date.getTime() > 90 * 864e5;
}
function auditSalesNote(note) {
	const findings = [];
	if (!note.frontmatter.type) findings.push("missing type");
	if (!note.frontmatter.status) findings.push("missing status");
	if (!note.frontmatter.owner) findings.push("missing owner");
	if (!note.frontmatter.updated || stale(note.frontmatter.updated)) findings.push("stale or missing updated date");
	if (!note.frontmatter.source && note.externalLinks.length === 0) findings.push("missing source or lineage");
	if (!/下一步|next step|客户动作|owner|负责人/i.test(note.content)) findings.push("missing customer action or owner");
	return {
		path: note.path,
		title: note.title,
		type: text(note.frontmatter.type) || "untyped",
		status: findings.length === 0 ? "ready" : findings.length <= 2 ? "partial" : "blocked",
		findings: findings.length ? findings : ["healthy"],
		nextActions: findings.length ? ["补齐证据、Owner、日期和下一客户动作，再进入销售 gate。"] : ["复核事实、客户陈述、假设和商业承诺是否分开。"]
	};
}
function buildSalesOnboarding(root, scan) {
	const dimensionsWithStatus = [
		{
			id: "context",
			label: "客户与价值上下文",
			evidence: scan.summary.salesNotes > 0 ? [`发现 ${scan.summary.salesNotes} 份销售笔记`] : [],
			missing: scan.summary.salesNotes > 0 ? [] : ["销售上下文、ICP、JTBD 或价值主张"],
			nextAction: "先建立 sales-context，并写明来源和目标客户"
		},
		{
			id: "pipeline",
			label: "商机管道与阶段",
			evidence: scan.summary.dataFiles > 0 ? [`发现 ${scan.summary.dataFiles} 个数据文件`] : [],
			missing: scan.summary.dataFiles > 0 ? [] : ["商机或客户推进数据"],
			nextAction: "补充带阶段、金额、Owner 和日期的数据"
		},
		{
			id: "evidence",
			label: "成交证据",
			evidence: scan.summary.salesNotes > 0 && scan.summary.missingSources === 0 ? ["销售笔记均有来源"] : [],
			missing: scan.summary.missingSources > 0 ? ["来源或证据 lineage"] : [],
			nextAction: "为客户原话、结果和承诺补充来源"
		},
		{
			id: "commercial",
			label: "报价与商业边界",
			evidence: [],
			missing: ["报价来源、成本基础、折扣授权和付款条款"],
			nextAction: "引用 dsh-business 或批准的商业上下文"
		}
	].map((dimension) => ({
		...dimension,
		status: dimension.missing.length === 0 ? "ready" : dimension.evidence.length > 0 ? "partial" : "blocked",
		score: dimension.missing.length === 0 ? 100 : dimension.evidence.length > 0 ? 50 : 0
	}));
	const overallScore = Math.round(dimensionsWithStatus.reduce((sum, dimension) => sum + dimension.score, 0) / dimensionsWithStatus.length);
	const currentStep = dimensionsWithStatus.find((dimension) => dimension.status !== "ready")?.id ?? "close";
	return {
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		root,
		overallStatus: overallScore >= 75 ? "ready" : overallScore > 0 ? "partial" : "blocked",
		overallScore,
		dimensions: dimensionsWithStatus,
		methods: [
			{
				id: "qualification",
				name: "MEDDICC / SPICED",
				status: scan.summary.salesNotes > 0 ? "partial" : "not-detected",
				evidence: [],
				nextAction: "围绕 Problem、Impact、Buyer、Process、Timing、Commitment 补证据"
			},
			{
				id: "discovery",
				name: "SPIN / Gap Selling",
				status: scan.summary.salesNotes > 0 ? "partial" : "not-detected",
				evidence: [],
				nextAction: "把客户问题连接到基线和期望结果"
			},
			{
				id: "commercial",
				name: "Value Selling / Mutual Action Plan",
				status: "not-detected",
				evidence: [],
				nextAction: "建立价值证明和客户共同推进计划"
			}
		],
		currentStep,
		topActions: dimensionsWithStatus.filter((dimension) => dimension.status !== "ready").slice(0, 2).map((dimension) => dimension.nextAction),
		warnings: scan.errors
	};
}
function scanSummaryForOnboarding(root, notes, dataFiles, errors) {
	const byType = {};
	const byStatus = {};
	let missingMetadata = 0;
	let staleNotes = 0;
	let missingSources = 0;
	const priorityFiles = [];
	for (const note of notes) {
		const audit = auditSalesNote(note);
		byType[audit.type] = (byType[audit.type] ?? 0) + 1;
		const status = text(note.frontmatter.status) || "unstated";
		byStatus[status] = (byStatus[status] ?? 0) + 1;
		if (!note.frontmatter.type || !note.frontmatter.status) missingMetadata += 1;
		if (audit.findings.some((finding) => finding.includes("stale"))) staleNotes += 1;
		if (audit.findings.some((finding) => finding.includes("source"))) missingSources += 1;
		if (audit.findings[0] !== "healthy") priorityFiles.push({
			path: note.path,
			title: note.title,
			type: audit.type,
			status,
			reasons: audit.findings
		});
	}
	return {
		root,
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		scannedFiles: notes.length + dataFiles.length,
		skippedFiles: 0,
		errors,
		summary: {
			salesNotes: notes.length,
			dataFiles: dataFiles.length,
			missingMetadata,
			staleNotes,
			missingSources,
			byType,
			byStatus
		},
		priorityFiles: priorityFiles.toSorted((left, right) => right.reasons.length - left.reasons.length).slice(0, 20)
	};
}
function parseSalesNote(path, content) {
	return parseNote(path, content);
}
function field(columns, preferred, candidates) {
	return findField(columns, preferred, candidates);
}
function daysBetween(start, end) {
	const from = Date.parse(start);
	const to = Date.parse(end);
	if (Number.isNaN(from) || Number.isNaN(to)) return void 0;
	return Math.max(0, Math.floor((to - from) / 864e5));
}
function normalizeCrmExport(dataset, mapping = {}) {
	const aliases$1 = {
		dealId: [
			"deal_id",
			"opportunity_id",
			"id",
			"商机编号"
		],
		stage: [
			"stage",
			"status",
			"阶段",
			"商机阶段"
		],
		amount: [
			"amount",
			"value",
			"deal_value",
			"金额",
			"合同金额"
		],
		closeDate: [
			"close_date",
			"expected_close",
			"成交日期",
			"预计成交日"
		],
		owner: [
			"owner",
			"sales_rep",
			"销售负责人",
			"负责人"
		],
		outcome: [
			"outcome",
			"result",
			"win_loss",
			"结果",
			"输赢"
		],
		segment: [
			"segment",
			"industry",
			"customer_type",
			"客户分群",
			"行业"
		],
		source: [
			"source",
			"lead_source",
			"来源",
			"渠道"
		]
	};
	const fieldMap = {};
	for (const [key, candidates] of Object.entries(aliases$1)) {
		const selected = mapping[key] ?? findField(dataset.columns, void 0, candidates);
		if (selected) fieldMap[key] = selected;
	}
	const records = dataset.rows.map((row) => {
		const normalized = { ...row };
		for (const [key, source] of Object.entries(fieldMap)) normalized[key] = row[source];
		return normalized;
	});
	const warnings = [...dataset.warnings];
	for (const key of [
		"dealId",
		"stage",
		"amount"
	]) if (!fieldMap[key]) warnings.push(`未识别 CRM 字段：${key}`);
	return {
		artifactType: "sales-crm-import",
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		source: dataset.source,
		rowsRead: dataset.rows.length,
		rowsAccepted: records.length,
		fieldMap,
		records,
		warnings,
		nextActions: warnings.length > 0 ? ["确认字段映射后再运行销售管道、阶段老化或 Win/Loss 分析。"] : ["保留原始来源和字段映射，再运行 sales_funnel_analyze 或 sales_win_loss_review。"]
	};
}
function analyzeStageAging(dataset, options = {}) {
	const stageField = field(dataset.columns, options.stageField, [
		"stage",
		"status",
		"opportunity_stage",
		"阶段",
		"商机阶段",
		"状态"
	]);
	const dateField = field(dataset.columns, options.dateField, [
		"created_at",
		"created_date",
		"stage_date",
		"date",
		"创建日期",
		"阶段日期"
	]);
	if (!stageField) throw new Error("Could not identify a stage field; provide stageField explicitly");
	if (!dateField) throw new Error("Could not identify a date field; provide dateField explicitly");
	const asOf = options.asOf ?? (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
	const grouped = /* @__PURE__ */ new Map();
	for (const row of dataset.rows) {
		const stage = normalizeStage(row[stageField]);
		const current = grouped.get(stage) ?? {
			ages: [],
			missingDate: 0
		};
		const age = daysBetween(valueString(row[dateField]), asOf);
		if (age === void 0) current.missingDate += 1;
		else current.ages.push(age);
		grouped.set(stage, current);
	}
	const stages = [...grouped.entries()].map(([stage, value]) => ({
		stage,
		records: value.ages.length + value.missingDate,
		averageAgeDays: value.ages.length > 0 ? Math.round(value.ages.reduce((sum, age) => sum + age, 0) / value.ages.length) : null,
		oldestAgeDays: value.ages.length > 0 ? Math.max(...value.ages) : null,
		missingDate: value.missingDate
	}));
	const warnings = [...dataset.warnings];
	if (stages.some((stage) => stage.missingDate > 0)) warnings.push("部分记录缺少可解析日期，老化天数不能代表全部商机。");
	return {
		artifactType: "sales-stage-aging",
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		source: dataset.source,
		asOf,
		stageField,
		dateField,
		stages,
		warnings,
		nextActions: ["优先检查平均或最老停留时间最高的阶段，并结合客户下一步动作复核。"]
	};
}
function reviewWinLoss(dataset, options = {}) {
	const outcomeField = field(dataset.columns, options.outcomeField, [
		"outcome",
		"result",
		"win_loss",
		"status",
		"结果",
		"输赢"
	]);
	const amountField = field(dataset.columns, options.amountField, [
		"amount",
		"value",
		"deal_value",
		"金额",
		"合同金额"
	]);
	const segmentField = field(dataset.columns, options.segmentField, [
		"segment",
		"industry",
		"customer_type",
		"客户分群",
		"行业"
	]);
	const reasonField = field(dataset.columns, options.reasonField, [
		"loss_reason",
		"reason",
		"unmet_need",
		"失单原因",
		"原因",
		"未满足需求"
	]);
	if (!outcomeField) throw new Error("Could not identify an outcome field; provide outcomeField explicitly");
	const groups = /* @__PURE__ */ new Map();
	const reasons = /* @__PURE__ */ new Map();
	let won = 0;
	let lost = 0;
	let wonAmount = 0;
	let lostAmount = 0;
	for (const row of dataset.rows) {
		const outcome = valueString(row[outcomeField]).toLowerCase();
		const isWon = [
			"won",
			"closed-won",
			"win",
			"赢单",
			"成交",
			"成功"
		].includes(outcome);
		const isLost = [
			"lost",
			"closed-lost",
			"loss",
			"输单",
			"失单",
			"失败"
		].includes(outcome);
		if (!isWon && !isLost) continue;
		const amount = numberValue(amountField ? row[amountField] : void 0) ?? 0;
		const segment = segmentField ? valueString(row[segmentField]) || "未分群" : "全部";
		const current = groups.get(segment) ?? {
			won: 0,
			lost: 0,
			wonAmount: 0,
			lostAmount: 0
		};
		if (isWon) {
			won += 1;
			wonAmount += amount;
			current.won += 1;
			current.wonAmount += amount;
		}
		if (isLost) {
			lost += 1;
			lostAmount += amount;
			current.lost += 1;
			current.lostAmount += amount;
			const reason = reasonField ? valueString(row[reasonField]) : "";
			if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
		}
		groups.set(segment, current);
	}
	const segments = [...groups.entries()].map(([segment, value]) => ({
		segment,
		...value,
		winRate: value.won + value.lost > 0 ? Math.round(value.won / (value.won + value.lost) * 1e3) / 10 : null
	}));
	const feedback = [...reasons.entries()].map(([reason, count]) => ({
		target: /功能|产品|缺少|集成|体验/i.test(reason) ? "dsh-product" : "dsh-idea",
		reason,
		count
	})).sort((a, b) => b.count - a.count);
	return {
		artifactType: "sales-win-loss-review",
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		source: dataset.source,
		outcomeField,
		...amountField ? { amountField } : {},
		...segmentField ? { segmentField } : {},
		summary: {
			won,
			lost,
			winRate: won + lost > 0 ? Math.round(won / (won + lost) * 1e3) / 10 : null,
			wonAmount,
			lostAmount
		},
		segments,
		feedback,
		warnings: [...dataset.warnings, ...won + lost < dataset.rows.length ? ["部分记录没有可识别的赢输结果，未纳入胜率。"] : []],
		nextActions: feedback.length > 0 ? ["将高频失单原因分别交给 dsh-product 或 dsh-idea，形成产品变更或新发现。"] : ["补充失单原因字段，再分析可行动的反馈回流。"]
	};
}
function artifactSlug(value) {
	return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "unknown";
}
function buildSalesFeedbackHandoff(input) {
	const review = reviewWinLoss(input.dataset, input.options);
	const generatedAt = (/* @__PURE__ */ new Date()).toISOString();
	const artifactId = `dsh-sales-feedback-${input.target}-${artifactSlug(input.dataset.source)}-${generatedAt.slice(0, 10)}`;
	const feedback = input.target === "dsh-growth" ? review.feedback : review.feedback.filter((item) => item.target === input.target);
	const warnings = [...review.warnings];
	if (feedback.length === 0) warnings.push(`没有明确归属 ${input.target} 的输赢反馈；请补充失单原因或人工分类。`);
	const nextActions = input.target === "dsh-product" ? ["由 dsh-product 评估是否形成产品变更影响审查，不把单一失单原因当作普遍需求。"] : input.target === "dsh-idea" ? ["由 dsh-idea 将重复且有证据的市场问题转成新发现，再安排最小验证实验。"] : ["由 dsh-growth 将成交与失单结果映射到收入、转化和回收期指标，保留原始来源。"];
	const handoff = {
		schemaVersion: "1.0",
		artifactId,
		artifactType: "sales-feedback-handoff",
		handoffFrom: "dsh-sales",
		handoffTo: input.target,
		generatedAt,
		source: input.dataset.source,
		target: input.target,
		summary: review.summary,
		segments: review.segments,
		feedback,
		warnings,
		nextActions,
		markdown: ""
	};
	handoff.markdown = [
		"---",
		"schemaVersion: \"1.0\"",
		`artifactId: ${JSON.stringify(artifactId)}`,
		"artifactType: sales-feedback-handoff",
		"handoffFrom: dsh-sales",
		`handoffTo: ${input.target}`,
		`generatedAt: ${generatedAt}`,
		`source: ${JSON.stringify(input.dataset.source)}`,
		"---",
		"# 销售反馈回流",
		"",
		`- 回流目标：${input.target}`,
		`- 赢单：${review.summary.won}`,
		`- 输单：${review.summary.lost}`,
		`- 胜率：${review.summary.winRate === null ? "缺失" : `${review.summary.winRate}%`}`,
		"",
		"## 可行动反馈",
		...feedback.length > 0 ? feedback.map((item) => `- ${item.reason}：${item.count} 次`) : ["- 无；需要补充原因或人工分类。"],
		"",
		"## 下一步",
		...nextActions.map((item) => `- ${item}`),
		""
	].join("\n");
	return handoff;
}

//#endregion
//#region src/vault.ts
const supported = new Set([
	".md",
	".markdown",
	".csv",
	".tsv",
	".json",
	".jsonl",
	".ndjson"
]);
function extension(path) {
	return path.match(/\.[^.\\/]+$/)?.[0].toLowerCase() ?? "";
}
function isSalesNote(note) {
	const type = String(note.frontmatter.type ?? "").toLowerCase();
	return [
		"sales-context",
		"deal-review",
		"pipeline-review",
		"sales-playbook",
		"offer-review",
		"win-loss"
	].includes(type) || /销售|成交|商机|pipeline|deal|MEDDICC|SPIN|报价|复购|扩单/i.test(note.content);
}
function childPath(parent, name$1) {
	return `${parent.replace(/[\\/]+$/, "")}/${name$1}`;
}
async function readSalesNote(fs, path, config, signal) {
	const target = await fs.resolve(path, { signal });
	const info = await fs.stat(target, signal);
	if (!info || info.type !== "file") throw new Error(`Markdown file not found: ${path}`);
	if ((info.size ?? 0) > config.maxFileBytes) throw new Error(`File exceeds maxFileBytes (${config.maxFileBytes})`);
	const content = await fs.readText(target, signal);
	if (content.length > config.maxTextChars) throw new Error(`File exceeds maxTextChars (${config.maxTextChars})`);
	return parseSalesNote(path, content);
}
async function scanSalesVault(fs, root, config, signal) {
	const notes = [];
	const dataFiles = [];
	const errors = [];
	let scannedFiles = 0;
	let skippedFiles = 0;
	async function visit(target, displayPath) {
		if (scannedFiles >= config.maxFiles) {
			skippedFiles += 1;
			return;
		}
		let entries;
		try {
			entries = await fs.listDir(target, signal);
		} catch (error) {
			errors.push(`${displayPath}: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		for (const entry of entries) {
			if (scannedFiles >= config.maxFiles) {
				skippedFiles += 1;
				continue;
			}
			if (entry.name.startsWith(".")) continue;
			const path = childPath(displayPath, entry.name);
			if (entry.type === "directory") {
				await visit(entry.target, path);
				continue;
			}
			const ext = extension(entry.name);
			if (entry.type !== "file" || !supported.has(ext)) continue;
			scannedFiles += 1;
			if ((entry.size ?? 0) > config.maxFileBytes) {
				skippedFiles += 1;
				errors.push(`${path}: exceeds maxFileBytes`);
				continue;
			}
			try {
				if (ext === ".md" || ext === ".markdown") {
					const content = await fs.readText(entry.target, signal);
					if (content.length > config.maxTextChars) {
						skippedFiles += 1;
						errors.push(`${path}: exceeds maxTextChars`);
						continue;
					}
					const note = parseSalesNote(path, content);
					if (isSalesNote(note)) notes.push(note);
				} else dataFiles.push(path);
			} catch (error) {
				errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	await visit(await fs.resolve(root, { signal }), root);
	const result = scanSummaryForOnboarding(root, notes, dataFiles, errors);
	result.scannedFiles = scannedFiles;
	result.skippedFiles = skippedFiles;
	return result;
}
function auditNoteForTool(note) {
	return auditSalesNote(note);
}

//#endregion
//#region src/tools.ts
function salesOutput(maxChars) {
	return {
		schema: resultSchema,
		render: (_args, value) => renderResult(value, maxChars)
	};
}
function wrapResult(value, options = {}) {
	const warnings = typeof value === "object" && value !== null && "warnings" in value && Array.isArray(value.warnings) ? value.warnings.filter((warning) => typeof warning === "string") : [];
	return resultEnvelope({
		data: jsonValue(value),
		warnings,
		assumptions: options.assumptions,
		lineage: options.lineage,
		nextActions: options.nextActions
	});
}
function parseList(value, label) {
	if (!value?.trim()) return [];
	try {
		const parsed = JSON.parse(value);
		if (Array.isArray(parsed)) return parsed.map((item) => String(item)).filter(Boolean);
	} catch {}
	return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).length > 0 ? value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) : (() => {
		throw new Error(`${label} must be a JSON array or newline-separated list`);
	})();
}
function parseObject(value, label) {
	let parsed;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new Error(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
	return parsed;
}
async function ensureInsideRoot(fs, config, path, signal) {
	const root = await fs.resolve(config.defaultRoot, { signal });
	const target = await fs.resolve(path, { signal });
	if (!fs.contains(root, target)) throw new Error(`Path is outside configured defaultRoot: ${path}`);
}
function registerSalesTools(ctx, config, fs) {
	ctx.tools.register(defineTool({
		name: "sales_crm_import",
		description: "Normalize a user-approved CRM CSV/JSON export into a read-only sales dataset while preserving source fields and field mapping. It never writes to a CRM or imports contact outreach state.",
		parameters: {
			path: {
				type: "string",
				required: true,
				description: "CRM export under defaultRoot."
			},
			fieldMappingJson: {
				type: "string",
				description: "Optional JSON object mapping normalized fields to source columns."
			}
		},
		output: salesOutput(config.maxResultChars),
		async execute(args, exec) {
			await ensureInsideRoot(fs, config, args.path, exec.signal);
			const result = normalizeCrmExport(await readSalesDataset(fs, config, args.path, exec.signal), args.fieldMappingJson ? parseObject(args.fieldMappingJson, "fieldMappingJson") : {});
			return wrapResult(result, {
				lineage: [{
					source: args.path,
					fields: Object.values(result.fieldMap)
				}],
				nextActions: result.nextActions
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "sales_stage_aging",
		description: "Analyze stage aging from a local sales export using a creation/stage date and an explicit as-of date. Missing or invalid dates remain visible.",
		parameters: {
			path: {
				type: "string",
				required: true,
				description: "Sales pipeline dataset under defaultRoot."
			},
			stageField: { type: "string" },
			dateField: { type: "string" },
			asOf: {
				type: "string",
				description: "ISO date used as the aging boundary."
			}
		},
		output: salesOutput(config.maxResultChars),
		async execute(args, exec) {
			await ensureInsideRoot(fs, config, args.path, exec.signal);
			const result = analyzeStageAging(await readSalesDataset(fs, config, args.path, exec.signal), args);
			return wrapResult(result, {
				lineage: [{
					source: args.path,
					fields: [result.stageField, result.dateField]
				}],
				nextActions: result.nextActions
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "sales_win_loss_review",
		description: "Review closed-won/closed-lost outcomes by segment and amount, and prepare feedback targets for dsh-product or dsh-idea. It does not infer causality from a reason count.",
		parameters: {
			path: {
				type: "string",
				required: true,
				description: "Sales export under defaultRoot."
			},
			outcomeField: { type: "string" },
			amountField: { type: "string" },
			segmentField: { type: "string" },
			reasonField: { type: "string" }
		},
		output: salesOutput(config.maxResultChars),
		async execute(args, exec) {
			await ensureInsideRoot(fs, config, args.path, exec.signal);
			const result = reviewWinLoss(await readSalesDataset(fs, config, args.path, exec.signal), args);
			return wrapResult(result, {
				lineage: [{ source: args.path }],
				nextActions: result.nextActions
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "sales_feedback_handoff",
		description: "Turn a reviewed CRM export into a versioned feedback handoff for dsh-product, dsh-idea or dsh-growth. It carries aggregated outcomes and reasons, not customer contact data.",
		parameters: {
			path: {
				type: "string",
				required: true,
				description: "Sales export under defaultRoot."
			},
			target: {
				type: "string",
				required: true,
				enum: [
					"dsh-product",
					"dsh-idea",
					"dsh-growth"
				]
			},
			outcomeField: { type: "string" },
			amountField: { type: "string" },
			segmentField: { type: "string" },
			reasonField: { type: "string" }
		},
		output: salesOutput(config.maxResultChars),
		async execute(args, exec) {
			await ensureInsideRoot(fs, config, args.path, exec.signal);
			const result = buildSalesFeedbackHandoff({
				dataset: await readSalesDataset(fs, config, args.path, exec.signal),
				target: args.target,
				options: args
			});
			return wrapResult(result, {
				lineage: [{ source: args.path }],
				nextActions: result.nextActions
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "sales_onboarding",
		description: "Run a read-only sales readiness check across local sales notes and pipeline data. It identifies the current commercial gate and the smallest next actions.",
		parameters: { root: {
			type: "string",
			description: "Optional directory under defaultRoot."
		} },
		output: salesOutput(config.maxResultChars),
		async execute(args, exec) {
			const root = args.root?.trim() || config.defaultRoot;
			await ensureInsideRoot(fs, config, root, exec.signal);
			const result = buildSalesOnboarding(root, await scanSalesVault(fs, root, config, exec.signal));
			return wrapResult(result, {
				lineage: [{ source: root }],
				nextActions: result.topActions
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "sales_audit_note",
		description: "Audit one Markdown sales context, deal review, pipeline review, offer review or playbook for metadata, evidence lineage and next-action completeness.",
		parameters: { path: {
			type: "string",
			required: true,
			description: "Markdown sales artifact under defaultRoot."
		} },
		output: salesOutput(config.maxResultChars),
		async execute(args, exec) {
			await ensureInsideRoot(fs, config, args.path, exec.signal);
			const result = auditNoteForTool(await readSalesNote(fs, args.path, config, exec.signal));
			return wrapResult(result, {
				lineage: [{ source: args.path }],
				nextActions: result.nextActions
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "sales_funnel_analyze",
		description: "Analyze a local CSV, TSV, JSON or JSONL sales pipeline by stage, amount and optional close date. Returns stage conversion, pipeline share, weighted amount and data gaps.",
		parameters: {
			path: {
				type: "string",
				required: true,
				description: "Sales pipeline dataset under defaultRoot."
			},
			stageField: {
				type: "string",
				description: "Stage column; inferred when omitted."
			},
			amountField: {
				type: "string",
				description: "Amount column; inferred when omitted."
			},
			dateField: {
				type: "string",
				description: "Expected close date column; inferred when omitted."
			},
			probabilityJson: {
				type: "string",
				description: "Optional JSON object mapping normalized stage to probability."
			}
		},
		output: salesOutput(config.maxResultChars),
		async execute(args, exec) {
			await ensureInsideRoot(fs, config, args.path, exec.signal);
			const result = analyzeSalesFunnel(await readSalesDataset(fs, config, args.path, exec.signal), args);
			ctx.emit("sales/analysis-completed", {
				kind: "funnel",
				source: args.path,
				warningCount: result.warnings.length
			});
			return wrapResult(result, {
				lineage: [{
					source: args.path,
					fields: [
						result.stageField,
						...result.amountField ? [result.amountField] : [],
						...result.dateField ? [result.dateField] : []
					]
				}],
				nextActions: result.nextActions
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "sales_commercial_handoff_review",
		description: "Consume and validate a dsh-business commercial-handoff before sales quoting or negotiation. It checks explicit price floors, cost/contribution facts, risk status and approval requirements; it never grants authority.",
		parameters: { handoffJson: {
			type: "string",
			required: true,
			description: "JSON returned by business_commercial_handoff, including its result envelope or data object."
		} },
		output: salesOutput(config.maxResultChars),
		async execute(args) {
			const parsed = parseObject(args.handoffJson, "handoffJson");
			const review = reviewCommercialHandoff(typeof parsed.data === "object" && parsed.data !== null && !Array.isArray(parsed.data) ? parsed.data : parsed);
			return wrapResult(review, {
				lineage: review.source ? [{ source: review.source }] : [],
				nextActions: review.nextActions
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "sales_product_handoff_review",
		description: "Consume and validate a dsh-product product-sales-handoff. It checks the product decision gate, value evidence, proof points, commercial context and customer next action before sales progression.",
		parameters: { handoffJson: {
			type: "string",
			required: true,
			description: "JSON returned by product_sales_handoff, including its result envelope or data object."
		} },
		output: salesOutput(config.maxResultChars),
		async execute(args) {
			const parsed = parseObject(args.handoffJson, "handoffJson");
			const review = reviewProductSalesHandoff(typeof parsed.data === "object" && parsed.data !== null && !Array.isArray(parsed.data) ? parsed.data : parsed);
			return wrapResult(review, {
				lineage: review.source ? [{ source: review.source }] : [],
				nextActions: review.nextActions
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "sales_deal_review",
		description: "Review one opportunity using Problem, Impact, Buyer, Process, Timing, Competition and Commitment evidence. The score is evidence coverage, not close probability.",
		parameters: {
			deal: {
				type: "string",
				required: true,
				description: "Deal or opportunity name."
			},
			facts: {
				type: "string",
				required: true,
				description: "JSON object. Each field may be a value or {value,status,source}; status is observed, customer-stated, estimated, inferred or missing."
			},
			source: {
				type: "string",
				description: "Source note or dataset path."
			}
		},
		output: salesOutput(config.maxResultChars),
		async execute(args) {
			const result = reviewDeal(args.deal, parseObject(args.facts, "facts"), args.source);
			return wrapResult(result, {
				lineage: args.source ? [{ source: args.source }] : [],
				assumptions: result.assumptions,
				nextActions: result.nextActions
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "sales_offer_review",
		description: "Review an offer for value evidence, price source, cost basis, discount authority and payment terms. It does not set a price or approve a discount.",
		parameters: {
			offer: {
				type: "string",
				required: true,
				description: "Offer, product or proposal name."
			},
			valueEvidence: {
				type: "string",
				description: "JSON array or newline-separated value evidence."
			},
			facts: {
				type: "string",
				required: true,
				description: "JSON object with targetCustomer, problem, desiredOutcome, priceSource, costBasis, discountAuthority and paymentTerms."
			}
		},
		output: salesOutput(config.maxResultChars),
		async execute(args) {
			const result = reviewOffer(args.offer, {
				valueEvidence: parseList(args.valueEvidence, "valueEvidence"),
				facts: parseObject(args.facts, "facts")
			});
			return wrapResult(result, { nextActions: result.nextActions });
		}
	}));
	ctx.tools.register(defineTool({
		name: "sales_forecast",
		description: "Create a weighted sales pipeline forecast from amount, stage and expected close date fields. Default probabilities are explicit heuristics and never a revenue guarantee.",
		parameters: {
			path: {
				type: "string",
				required: true,
				description: "Sales pipeline dataset under defaultRoot."
			},
			stageField: {
				type: "string",
				description: "Stage column; inferred when omitted."
			},
			amountField: {
				type: "string",
				description: "Amount column; inferred when omitted."
			},
			closeDateField: {
				type: "string",
				description: "Expected close date column; inferred when omitted."
			},
			currency: {
				type: "string",
				description: "Currency code; defaults to plugin configuration."
			},
			asOf: {
				type: "string",
				description: "ISO date used to identify stale open opportunities."
			},
			probabilityJson: {
				type: "string",
				description: "Optional JSON object mapping normalized stage to probability."
			}
		},
		output: salesOutput(config.maxResultChars),
		async execute(args, exec) {
			await ensureInsideRoot(fs, config, args.path, exec.signal);
			const result = forecastPipeline(await readSalesDataset(fs, config, args.path, exec.signal), {
				...args,
				currency: args.currency?.trim() || config.defaultCurrency
			});
			return wrapResult(result, {
				lineage: [{ source: args.path }],
				assumptions: result.assumptions,
				nextActions: result.nextActions
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "sales_playbook_generate",
		description: "Generate a concise sales playbook or deal-push artifact from approved inputs. It returns Markdown for review and does not contact customers.",
		parameters: {
			title: {
				type: "string",
				required: true,
				description: "Artifact title."
			},
			targetCustomer: {
				type: "string",
				required: true,
				description: "Target customer or buyer."
			},
			salesMotion: {
				type: "string",
				required: true,
				description: "Direct, partner, self-serve or hybrid motion."
			},
			valueProposition: {
				type: "string",
				required: true,
				description: "Evidence-backed value proposition."
			},
			discoveryQuestions: {
				type: "string",
				required: true,
				description: "JSON array or newline-separated questions."
			},
			qualificationCriteria: {
				type: "string",
				required: true,
				description: "JSON array or newline-separated criteria."
			},
			objections: {
				type: "string",
				description: "JSON array or newline-separated objection-handling principles."
			},
			nextStep: {
				type: "string",
				required: true,
				description: "One observable customer next action."
			},
			source: {
				type: "string",
				description: "Source note or handoff path."
			}
		},
		output: salesOutput(config.maxResultChars),
		async execute(args) {
			const result = generatePlaybook({
				title: args.title,
				targetCustomer: args.targetCustomer,
				salesMotion: args.salesMotion,
				valueProposition: args.valueProposition,
				discoveryQuestions: parseList(args.discoveryQuestions, "discoveryQuestions"),
				qualificationCriteria: parseList(args.qualificationCriteria, "qualificationCriteria"),
				objections: parseList(args.objections, "objections"),
				nextStep: args.nextStep,
				source: args.source
			});
			return wrapResult(result, {
				lineage: args.source ? [{ source: args.source }] : [],
				nextActions: result.nextActions
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "sales_apply_artifact",
		description: "Preview or apply a complete Markdown sales artifact under defaultRoot using a stale-version guard. Set confirm=true only after explicit approval.",
		parameters: {
			path: {
				type: "string",
				required: true,
				description: "Markdown sales artifact to update."
			},
			content: {
				type: "string",
				required: true,
				description: "Complete replacement Markdown content."
			},
			confirm: {
				type: "boolean",
				required: true,
				description: "false previews only; true applies the guarded write."
			}
		},
		output: salesOutput(config.maxResultChars),
		async execute(args, exec) {
			await ensureInsideRoot(fs, config, args.path, exec.signal);
			if (args.content.length > config.maxTextChars) throw new Error(`Replacement exceeds maxTextChars (${config.maxTextChars})`);
			const target = await fs.resolve(args.path, { signal: exec.signal });
			const info = await fs.stat(target, exec.signal);
			if (!info || info.type !== "file") throw new Error(`File not found: ${args.path}`);
			const current = await fs.readText(target, exec.signal);
			if (!args.confirm) {
				ctx.emit("sales/report-previewed", { path: args.path });
				return wrapResult({
					status: "preview-only",
					path: args.path,
					changed: args.content !== current,
					applied: false,
					diff: replacementDiff(current, args.content)
				}, { nextActions: ["审阅 diff；明确确认后再以 confirm=true 写回。"] });
			}
			await fs.writeText(target, args.content, {
				kind: "replaceIfVersion",
				version: info.version
			}, exec.signal);
			ctx.emit("sales/report-applied", { path: args.path });
			return wrapResult({
				status: "applied",
				path: args.path,
				changed: args.content !== current,
				applied: true,
				guarded: true
			}, { lineage: [{ source: args.path }] });
		}
	}));
}

//#endregion
//#region src/index.ts
const name = "dsh-sales";
const inject = ["tools", "fs"];
const Config = Schema.object({
	defaultRoot: Schema.string().default("."),
	reportDir: Schema.string().default(".dsh-sales/reports"),
	maxFiles: Schema.number().step(1).min(1).max(5e3).default(500),
	maxRows: Schema.number().step(1).min(1).max(5e5).default(1e5),
	maxFileBytes: Schema.number().step(1).min(1024).max(10485760).default(1048576),
	maxTextChars: Schema.number().step(1).min(1e3).max(1e6).default(18e4),
	maxResultChars: Schema.number().step(1).min(1e3).max(2e5).default(5e4),
	defaultCurrency: Schema.string().default("CNY"),
	defaultTimezone: Schema.string().default("Asia/Shanghai")
});
function apply(ctx, config) {
	const fs = ctx.fs;
	registerSalesTools(ctx, config, fs);
	ctx.logger.info(`[${name}] registered sales tools for ${config.defaultRoot}`);
}

//#endregion
export { Config, apply, inject, name };