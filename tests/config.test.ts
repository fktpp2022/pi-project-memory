import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";

test("parseConfig accepts independent role models", () => {
	const config = parseConfig({
		models: {
			selector: { model: "openai/selector", thinkingLevel: "minimal", maxTokens: 300 },
			extractor: { model: "anthropic/extractor", thinkingLevel: "low", maxTokens: 2000 },
			dream: { model: "google/dream", thinkingLevel: "high", maxTokens: 7000 },
		},
	});
	assert.equal(config.models.selector.model, "openai/selector");
	assert.equal(config.models.extractor.model, "anthropic/extractor");
	assert.equal(config.models.dream.model, "google/dream");
});

test("parseConfig uses Claude-compatible selector defaults and inherited maintenance budgets", () => {
	const config = parseConfig({});
	assert.equal(config.models.selector.maxTokens, 512);
	assert.equal(config.models.selector.structuredOutput, true);
	assert.equal(config.models.extractor.thinkingLevel, "inherit");
	assert.equal(config.models.dream.thinkingLevel, "inherit");
	assert.equal(config.models.extractor.maxTokens, "inherit");
	assert.equal(config.models.dream.maxTokens, "inherit");
	assert.equal(config.extraction.recentMessages, "inherit");
	assert.equal(config.dream.maxTurns, 50);
	assert.equal(
		parseConfig({
			models: { selector: { maxTokens: 1024, structuredOutput: false } },
			extraction: { recentMessages: 20 },
		}).models.selector.maxTokens,
		1024,
	);
	assert.equal(
		parseConfig({ models: { selector: { structuredOutput: false } } }).models.selector.structuredOutput,
		false,
	);
	assert.equal(parseConfig({ extraction: { recentMessages: 20 } }).extraction.recentMessages, 20);
	assert.equal(
		parseConfig({ models: { selector: { thinkingLevel: "inherit" } } }).models.selector.thinkingLevel,
		"inherit",
	);
	assert.equal(parseConfig({ models: { dream: { thinkingLevel: "high" } } }).models.dream.thinkingLevel, "high");
});

test("config.example.json stays identical to DEFAULT_CONFIG", async () => {
	const example = JSON.parse(await readFile(new URL("../config.example.json", import.meta.url), "utf8"));
	assert.deepEqual(example, DEFAULT_CONFIG);
});

test("package metadata declares the supported platforms", async () => {
	const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	assert.deepEqual(packageJson.os, ["darwin", "linux", "win32", "android"]);
	assert.equal(packageJson.cpu, undefined);
	assert.equal(packageJson.engines.node, ">=22.19.0");
});

test("parseConfig accepts large safe integers without field-specific maxima", () => {
	const large = Number.MAX_SAFE_INTEGER;
	const config = parseConfig({
		models: Object.fromEntries(["selector", "extractor", "dream"].map((role) => [role, { maxTokens: large }])),
		extraction: { everyNTurns: large, idleFlushSeconds: large, maxTurns: large, recentMessages: large },
		dream: { minimumHours: large, minimumOtherSessions: large, scanThrottleSeconds: large, maxTurns: large },
	});
	for (const model of Object.values(config.models)) assert.equal(model.maxTokens, large);
	for (const [key, value] of Object.entries(config.extraction)) if (key !== "enabled") assert.equal(value, large);
	for (const [key, value] of Object.entries(config.dream)) if (key !== "enabled") assert.equal(value, large);
});

test("parseConfig rejects invalid numbers and values below minima", () => {
	for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "100"]) {
		const config = parseConfig({ models: { dream: { maxTokens: value } }, extraction: { maxTurns: value } });
		assert.equal(config.models.dream.maxTokens, DEFAULT_CONFIG.models.dream.maxTokens);
		assert.equal(config.extraction.maxTurns, DEFAULT_CONFIG.extraction.maxTurns);
	}
	assert.equal(parseConfig({ extraction: { everyNTurns: 0 } }).extraction.everyNTurns, 1);
});
