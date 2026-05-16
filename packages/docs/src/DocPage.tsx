import { useEffect } from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import "./DocPage.css";

function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as React.ReactElement<{ children?: React.ReactNode }>).props.children);
  }
  return "";
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

function makeHeading(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${level}` as const;
  return ({ children }: { children?: React.ReactNode }) => {
    const id = slugify(extractText(children));
    return <Tag id={id}>{children}</Tag>;
  };
}

export const headingComponents: Partial<Components> = {
  h1: makeHeading(1),
  h2: makeHeading(2),
  h3: makeHeading(3),
  h4: makeHeading(4),
  h5: makeHeading(5),
  h6: makeHeading(6),
};

import gettingStarted from "../content/getting-started.md?raw";
import cli from "../content/cli.md?raw";
import scannerInputs from "../content/scanner-inputs.md?raw";
import policyAndSafety from "../content/policy-and-safety.md?raw";
import apiSdk from "../content/api-sdk.md?raw";
import integrations from "../content/integrations.md?raw";
import agentEcosystems from "../content/agent-ecosystems.md?raw";
import contributorGuide from "../content/contributor-guide.md?raw";
import changelog from "../../core/CHANGELOG.md?raw";

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
  { slug: "agent-ecosystems", title: "Agent Ecosystems", body: agentEcosystems },
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
    <article className="markdown-rendered">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={headingComponents}>{doc.body}</ReactMarkdown>
    </article>
  );
}