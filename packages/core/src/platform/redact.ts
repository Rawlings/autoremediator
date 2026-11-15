/**
 * Remove credentials from text that is about to be shown or stored. git is given its auth header on
 * the command line (older gits cannot take it from the environment), and a failed command's error
 * message repeats the whole command line, so anything that surfaces such an error goes through here.
 */
export function redactSecrets(text: string): string {
  return text
    .replaceAll(/(AUTHORIZATION:\s*(?:basic|bearer)\s+)[^\s'"]+/gi, "$1***")
    .replaceAll(/(\/\/)[^/@\s'"]+:[^@\s'"]+@/g, "$1***@");
}
