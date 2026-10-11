/** Remove import syntax from code copied into generated string data. Some Edge
 * bundler import scanners inspect generated files textually, including strings. */
export function sanitizeEvidenceLines(source) {
  return source.split('\n').map((line) => {
    if (/^\s*import\b/.test(line) || /\bimport\s*\(/.test(line)) {
      return '// import syntax omitted from indexed evidence'
    }
    return line
  })
}
