import { useEffect } from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./DocPage.css";

import gettingStarted from "../content/getting-started.md?raw";
import cli from "../content/cli.md?raw";
import scannerInputs from "../content/scanner-inputs.md?raw";
import policyAndSafety from "../content/policy-and-safety.md?raw";
import apiSdk from "../content/api-sdk.md?raw";
import integrations from "../content/integrations.md?raw";
import contributorGuide from "../content/contributor-guide.md?raw";
import changelog from "../content/changelog.md?raw";

export type Doc = {
  slug: string;
  title: string;
  body: string;
};

export const docs: Doc[] = [
  { slug: "getting-started", title: "Getting Started", body: gettingStarted },
  { slug: "cli", title: "CLI Reference", body: cli },
  { slug: "scanner-inputs", title: "Scanner Inputs", body: scannerInputs },
  { slug: "policy-and-safety", title: "Policy and Safety", body: policyAndSafety },
  { slug: "api-sdk", title: "API and SDK", body: apiSdk },
  { slug: "integrations", title: "Integrations", body: integrations },
  { slug: "contributor-guide", title: "Contributor Guide", body: contributorGuide },
  { slug: "changelog", title: "Changelog", body: changelog },
];

function findDoc(slug: string | undefined): Doc | undefined {
  return docs.find((doc) => doc.slug === slug);
}

function setMetaTag(key: "name" | "property", value: string, content: string): void {
  const selector = `meta[${key}="${value}"]`;
  const existing = document.head.querySelector(selector);
  if (existing) {
    existing.setAttribute("content", content);
    return;
  }

  const meta = document.createElement("meta");
  meta.setAttribute(key, value);
  meta.setAttribute("content", content);
  document.head.appendChild(meta);
}

export function setCanonical(href: string): void {
  let canonical = document.head.querySelector("link[rel='canonical']") as HTMLLinkElement | null;
  if (!canonical) {
    canonical = document.createElement("link");
    canonical.setAttribute("rel", "canonical");
    document.head.appendChild(canonical);
  }
  canonical.setAttribute("href", href);
}

export function DocPage() {
  const { slug } = useParams();
  const location = useLocation();
  const doc = findDoc(slug);

  useEffect(() => {
    if (!doc) return;

    const title = `${doc.title} | Autoremediator`;
    const description = `${doc.title} reference for automation-first, policy-aware CVE remediation in Node.js projects.`;
    const canonicalUrl = `https://rawlings.github.io/autoremediator${location.pathname}`;

    document.title = title;
    setMetaTag("name", "description", description);
    setMetaTag("property", "og:title", title);
    setMetaTag("property", "og:description", description);
    setMetaTag("property", "og:url", canonicalUrl);
    setMetaTag("name", "twitter:title", title);
    setMetaTag("name", "twitter:description", description);
    setCanonical(canonicalUrl);
  }, [doc, location.pathname]);

  if (!doc) {
    return <Navigate to={`/docs/${docs[0].slug}`} replace />;
  }

  return (
    <main className="content">
      <article className="markdown-rendered">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.body}</ReactMarkdown>
      </article>
    </main>
  );
}