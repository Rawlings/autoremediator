import { Navigate, NavLink, Route, Routes, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";

import gettingStarted from "../content/getting-started.md?raw";
import cli from "../content/cli.md?raw";
import scannerInputs from "../content/scanner-inputs.md?raw";
import policyAndSafety from "../content/policy-and-safety.md?raw";
import apiSdk from "../content/api-sdk.md?raw";
import integrations from "../content/integrations.md?raw";
import contributorGuide from "../content/contributor-guide.md?raw";

type Doc = {
  slug: string;
  title: string;
  body: string;
};

const docs: Doc[] = [
  { slug: "getting-started", title: "Getting Started", body: gettingStarted },
  { slug: "cli", title: "CLI Reference", body: cli },
  { slug: "scanner-inputs", title: "Scanner Inputs", body: scannerInputs },
  { slug: "policy-and-safety", title: "Policy and Safety", body: policyAndSafety },
  { slug: "api-sdk", title: "API and SDK", body: apiSdk },
  { slug: "integrations", title: "Integrations", body: integrations },
  { slug: "contributor-guide", title: "Contributor Guide", body: contributorGuide },
];

function findDoc(slug: string | undefined): Doc | undefined {
  return docs.find((doc) => doc.slug === slug);
}

function DocPage() {
  const { slug } = useParams();
  const doc = findDoc(slug);

  if (!doc) {
    return <Navigate to={`/docs/${docs[0].slug}`} replace />;
  }

  return (
    <main className="content">
      <header className="content-header">
        <h2>{doc.title}</h2>
      </header>
      <article className="markdown-rendered">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.body}</ReactMarkdown>
      </article>
    </main>
  );
}

function App() {
  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>Autoremediator Docs</h1>
        <p className="subtitle">Security remediation documentation and references</p>
        <nav>
          {docs.map((doc) => (
            <NavLink
              key={doc.slug}
              to={`/docs/${doc.slug}`}
              className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")}
            >
              {doc.title}
            </NavLink>
          ))}
        </nav>
      </aside>

      <Routes>
        <Route path="/" element={<Navigate to={`/docs/${docs[0].slug}`} replace />} />
        <Route path="/docs/:slug" element={<DocPage />} />
        <Route path="*" element={<Navigate to={`/docs/${docs[0].slug}`} replace />} />
      </Routes>
    </div>
  );
}

export default App;
