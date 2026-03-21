import { useMemo, useState } from "react";
import "./App.css";

import gettingStarted from "../getting-started.md?raw";
import cli from "../cli.md?raw";
import scannerInputs from "../scanner-inputs.md?raw";
import policyAndSafety from "../policy-and-safety.md?raw";
import apiSdk from "../api-sdk.md?raw";
import integrations from "../integrations.md?raw";
import migrationFromNpm from "../migration-from-npm.md?raw";
import contributorGuide from "../contributor-guide.md?raw";

type DocKey =
  | "getting-started"
  | "cli"
  | "scanner-inputs"
  | "policy-and-safety"
  | "api-sdk"
  | "integrations"
  | "migration-from-npm"
  | "contributor-guide";

const DOCS: Array<{ key: DocKey; title: string; body: string }> = [
  { key: "getting-started", title: "Getting Started", body: gettingStarted },
  { key: "cli", title: "CLI Reference", body: cli },
  { key: "scanner-inputs", title: "Scanner Inputs", body: scannerInputs },
  { key: "policy-and-safety", title: "Policy and Safety", body: policyAndSafety },
  { key: "api-sdk", title: "API and SDK", body: apiSdk },
  { key: "integrations", title: "Integrations", body: integrations },
  { key: "migration-from-npm", title: "Migration: npm to pnpm", body: migrationFromNpm },
  { key: "contributor-guide", title: "Contributor Guide", body: contributorGuide },
];

function App() {
  const [selectedDoc, setSelectedDoc] = useState<DocKey>("getting-started");

  const activeDoc = useMemo(
    () => DOCS.find((doc) => doc.key === selectedDoc) ?? DOCS[0],
    [selectedDoc]
  );

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>Autoremediator Docs</h1>
        <p className="subtitle">Vite + React + TypeScript</p>
        <nav>
          {DOCS.map((doc) => (
            <button
              key={doc.key}
              className={doc.key === activeDoc.key ? "nav-item active" : "nav-item"}
              onClick={() => setSelectedDoc(doc.key)}
            >
              {doc.title}
            </button>
          ))}
        </nav>
      </aside>

      <main className="content">
        <header className="content-header">
          <h2>{activeDoc.title}</h2>
        </header>
        <article className="markdown-preview">
          <pre>{activeDoc.body}</pre>
        </article>
      </main>
    </div>
  );
}

export default App;
