/** One accepted maintainer `not_affected` statement that applies to a vulnerable installed package. */
export interface MaintainerVexEvidence {
  /** The installed package that shipped the document and made the statement. */
  maintainer: { name: string; version: string };
  /** The document's path inside that package. */
  file: string;
  documentId: string;
  author: string;
  statementId?: string;
  status: "not_affected";
  justification: string;
  impactStatement?: string;
  statusNotes?: string;
  timestamp: string;
  /** The statement names the vulnerable package as a subcomponent (otherwise it is about the maintainer's own package). */
  subcomponent: boolean;
}

export interface MaintainerVexIgnored {
  maintainer: { name: string; version: string };
  reason: string;
}
