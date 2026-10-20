# Relic

Technical architecture & reference manual — v1.0.0

## Overview

Relic is a modern, high-performance Node.js and TypeScript orchestration engine and library designed for
modern backend architectures. It simplifies the creation, management, and orchestration of scalable
microservices, automated data workflows, and internal developer tooling.

By combining strict compile-time type safety with a resilient runtime engine, Relic reduces boilerplate for
distributed event handling, asynchronous tasks, and integration pipelines.

### Primary use cases

- **Microservice orchestration** — standardize communication and state management across distributed service layers.
- **Data pipeline execution** — construct fault-tolerant processing queues with declarative lifecycle hooks.
- **Developer tooling & CLI interfaces** — build internal utilities using structured SDK models and interactive interfaces.

## Key features & architecture

Relic uses a modular architecture centered on an asynchronous event loop and runtime worker pool.

- **TypeScript-first core** — native type definitions ensuring full compile-time safety and self-documenting code bases.
- **Dual execution models** — works seamlessly as an imported SDK within server applications or as an interactive CLI utility for operational scripts.
- **Pipeline orchestration** — built-in state machine for handling complex async operations, retries, exponential backoffs, and dead-letter queues.
- **Extensible plugin ecosystem** — standardized plugin lifecycle hooks (`onInit`, `preExecute`, `postExecute`, `onError`) for rapid integration with databases, observability tools, and message brokers.

### High-level component architecture

| Component       | Responsibility                                                        | Primary interface          |
| --------------- | --------------------------------------------------------------------- | -------------------------- |
| Relic Core SDK  | Lifecycle management, client initialization, configuration validation | `RelicClient`              |
| Pipeline Engine | Execution, queue processing, concurrency management                   | `client.executePipeline()` |
| Plugin Registry | Intercepts operations, provides logging and monitoring integrations   | `RelicPlugin`              |
| CLI Toolkit     | Terminal-based orchestration, scaffolding, interactive diagnostics    | `@rjoydip/relic/cli`       |

## Installation & getting started

### Prerequisites

- **Node.js** — version 18.0.0 or higher.
- **Package manager** — npm, yarn, pnpm, or bun.

### Installation

::: code-group

```sh [npm]
npm install @rjoydip/relic
```

```sh [pnpm]
pnpm add @rjoydip/relic
```

```sh [yarn]
yarn add @rjoydip/relic
```

```sh [bun]
bun add @rjoydip/relic
```

:::

### Quick start example

The following example demonstrates client instantiation, initialization, and simple pipeline invocation.

```ts
import { RelicClient } from "@rjoydip/relic";

const client = new RelicClient({
  environment: "production",
  timeout: 5000,
  retries: 3,
  webhooks: {
    enabled: true,
    endpoint: "https://api.example.com/webhooks/relic",
  },
});

async function main() {
  try {
    // Bootstrap internal core services and connection pools
    await client.initialize();

    console.log(`Relic engine initialized successfully. Active version: ${client.version}`);

    // Trigger an asynchronous processing pipeline
    const result = await client.executePipeline("user-ingestion-pipeline", {
      batchSize: 250,
      source: "external_webhook",
    });

    console.log(`Pipeline Execution Status: ${result.status}`, result.data);
  } catch (error) {
    console.error("Failed to execute Relic workflow:", error);
  }
}

main();
```

## API reference

### `RelicClient`

The foundational class for managing core configurations, connection lifecycles, and pipeline executions.

#### `new RelicClient(options: RelicConfig)`

Instantiates the Relic engine instance with the specified configuration options.

#### `client.initialize(): Promise<void>`

Bootstraps internal modules, establishes state store connections, and validates the configured environment
options. Must be called prior to running pipelines.

#### `client.executePipeline<T, R>(pipelineId: string, payload: T): Promise<PipelineResult<R>>`

Triggers a registered data processing pipeline by its unique identifier.

- **`pipelineId`** (`string`) — the target identifier registered in the system.
- **`payload`** (`Record<string, any>`) — input data passed directly to the initial pipeline node.

Returns a `Promise<PipelineResult>` containing execution status, output data, execution duration, and metadata.

### Key interfaces & types

```ts
export type Environment = "development" | "staging" | "production";

export interface WebhookConfig {
  enabled: boolean;
  endpoint?: string;
  secret?: string;
}

export interface RelicConfig {
  environment: Environment;
  timeout?: number;
  retries?: number;
  webhooks?: WebhookConfig;
}

export interface PipelineResult<T = any> {
  executionId: string;
  pipelineId: string;
  status: "SUCCESS" | "FAILED" | "TIMEOUT";
  data: T;
  durationMs: number;
  timestamp: string;
}
```

## Configuration schema

Relic can be configured programmatically or via a standard configuration file (`relic.config.json` or
`.relicrc`) placed at the root of your application repository.

```json
{
  "$schema": "https://json.schemastore.org/relic.json",
  "mode": "production",
  "timeout": 5000,
  "retries": 3,
  "logging": {
    "level": "info",
    "format": "json"
  },
  "webhooks": {
    "enabled": true,
    "endpoint": "https://events.internal.domain/relic"
  }
}
```

## Contributing & licensing

Contributions to Relic are welcome. Please ensure all pull requests pass type-checking, linting, and unit
test suites before submitting.

- **GitHub repository** — [github.com/rjoydip/relic](https://github.com/rjoydip/relic)
- **Issue tracker** — [github.com/rjoydip/relic/issues](https://github.com/rjoydip/relic/issues)
- **License** — released under the permissive MIT License.
