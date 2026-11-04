function wrap(node) {
  if (!node.children) return;
  node.children = node.children.map((child) => {
    if (child.type === 'element' && child.tagName === 'table') {
      return {
        type: 'element',
        tagName: 'div',
        properties: { className: ['o-table'] },
        children: [child]
      };
    }
    wrap(child);
    return child;
  });
}

export default function rehypeWrapTables() {
  return wrap;
}
