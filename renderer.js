// CodeMirror Editor Setup for Renderer Process
const { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine, Decoration, ViewPlugin } = require('@codemirror/view');
const { EditorState, StateField, StateEffect, RangeSetBuilder } = require('@codemirror/state');
const { sql } = require('@codemirror/lang-sql');
const { json } = require('@codemirror/lang-json');
const { defaultKeymap, history, historyKeymap } = require('@codemirror/commands');
const { searchKeymap, highlightSelectionMatches } = require('@codemirror/search');
const { syntaxHighlighting, HighlightStyle, LanguageSupport, StreamLanguage } = require('@codemirror/language');
const { tags } = require('@lezer/highlight');
const { autocompletion, acceptCompletion, startCompletion } = require('@codemirror/autocomplete');

// Custom theme for comments
const customHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: "#9ccc9c" },
  { tag: tags.keyword, color: "#0000ff", fontWeight: "bold" },
  { tag: tags.string, color: "#032f62" },
  { tag: tags.number, color: "#005cc5" }
]);

// Custom decorator for // comments (SQL mode only recognizes -- by default)
const slashCommentDecoration = Decoration.mark({ class: "cm-comment" });

const slashCommentPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = this.buildDecorations(view);
  }
  
  update(update) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = this.buildDecorations(update.view);
    }
  }
  
  buildDecorations(view) {
    const builder = new RangeSetBuilder();
    const doc = view.state.doc;
    
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const lineText = line.text;
      const slashIndex = lineText.indexOf('//');
      
      if (slashIndex !== -1) {
        const from = line.from + slashIndex;
        const to = line.to;
        builder.add(from, to, slashCommentDecoration);
      }
    }
    
    return builder.finish();
  }
}, {
  decorations: v => v.decorations
});

// Custom decorator for REST API syntax - highlights JSON-like portions
const restObjectDecoration = Decoration.mark({ class: "cm-rest-object" });

const restSyntaxPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = this.buildDecorations(view);
  }
  
  update(update) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = this.buildDecorations(update.view);
    }
  }
  
  buildDecorations(view) {
    const builder = new RangeSetBuilder();
    const doc = view.state.doc;
    
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const lineText = line.text;
      
      // Check if this is a REST API line (object name followed by opening brace, with optional ID)
      const restMatch = lineText.match(/^\s*(\w+)(?:\/[a-zA-Z0-9]+)?\s*\{/);
      if (!restMatch) continue;
      
      // Highlight just the object name with custom style
      const objectStart = lineText.indexOf(restMatch[1]);
      const objectEnd = objectStart + restMatch[1].length;
      builder.add(line.from + objectStart, line.from + objectEnd, restObjectDecoration);
    }
    
    return builder.finish();
  }
}, {
  decorations: v => v.decorations
});

function extractJsonObject(text, startIndex) {
  if (startIndex < 0 || startIndex >= text.length || text[startIndex] !== "{") {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        escapeNext = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const jsonText = text.slice(startIndex, i + 1);
        return {
          jsonText,
          nextIndex: i + 1
        };
      }
    }
  }

  return null;
}

function formatJsonLikeText(text) {
  const raw = text || "";
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Pure JSON selection/block.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return JSON.stringify(parsed, null, 2);
    } catch {
      // Fall through to REST-style parsing.
    }
  }

  // REST style: [METHOD] Path {json} or [METHOD] Path {headers} {body}
  let rest = trimmed;
  let methodPrefix = "";
  const methodMatch = rest.match(/^(GET|POST|PATCH|PUT|DELETE)\s+/i);
  if (methodMatch) {
    methodPrefix = methodMatch[1].toUpperCase();
    rest = rest.slice(methodMatch[0].length).trim();
  }

  const firstBrace = rest.indexOf("{");
  if (firstBrace === -1) return null;

  const path = rest.slice(0, firstBrace).trim();
  if (!path) return null;

  const jsonSection = rest.slice(firstBrace);
  const formattedObjects = [];
  let cursor = 0;

  while (cursor < jsonSection.length) {
    while (cursor < jsonSection.length && /\s/.test(jsonSection[cursor])) {
      cursor++;
    }

    if (cursor >= jsonSection.length) break;
    if (jsonSection[cursor] !== "{") return null;

    const extracted = extractJsonObject(jsonSection, cursor);
    if (!extracted) return null;

    try {
      const parsed = JSON.parse(extracted.jsonText);
      formattedObjects.push(JSON.stringify(parsed, null, 2));
    } catch {
      return null;
    }

    cursor = extracted.nextIndex;
  }

  if (formattedObjects.length === 0) return null;

  const prefix = methodPrefix ? `${methodPrefix} ${path}` : path;
  return `${prefix} ${formattedObjects.join("\n")}`;
}

function getCurrentBlockRange(doc, position) {
  let startLine = doc.lineAt(position).number;
  let endLine = startLine;

  while (startLine > 1 && doc.line(startLine - 1).text.trim() !== "") {
    startLine--;
  }

  while (endLine < doc.lines && doc.line(endLine + 1).text.trim() !== "") {
    endLine++;
  }

  return {
    from: doc.line(startLine).from,
    to: doc.line(endLine).to
  };
}

function formatSelection(view) {
  const selection = view.state.selection.main;
  const hasSelection = selection.from !== selection.to;
  const range = hasSelection
    ? { from: selection.from, to: selection.to }
    : getCurrentBlockRange(view.state.doc, selection.head);

  const originalText = view.state.doc.sliceString(range.from, range.to);
  const formattedText = formatJsonLikeText(originalText);

  if (!formattedText) {
    if (typeof window.showAlert === "function") {
      window.showAlert("No valid JSON found to format.");
    }
    return true;
  }

  view.dispatch({
    changes: { from: range.from, to: range.to, insert: formattedText },
    selection: { anchor: range.from, head: range.from + formattedText.length }
  });
  return true;
}

window.createCodeMirrorEditor = function(parent) {
  // SOQL autocomplete function
  const soqlAutocompletion = async (context) => {
    const text = context.state.doc.toString();
    const cursorPos = context.pos;
    
    // Get autocomplete context using existing logic
    const acContext = window.getAutocompleteContext ? window.getAutocompleteContext(text, cursorPos) : null;
    
    if (!acContext) return null;
    
    let suggestions = [];
    
    try {
      if (acContext.type === 'object') {
        const sobjects = await window.fetchSObjects();
        suggestions = sobjects.map(obj => {
          const objName = typeof obj === 'string' ? obj : obj.name;
          const objLabel = typeof obj === 'object' ? obj.label : '';
          const isTooling = obj.isTooling === true;
          const isBoth = obj.isBoth === true;
          const sourcePrefix = isBoth ? '🔩 ' : (isTooling ? '⚙️ ' : '');
          return {
            label: objName,
            type: "class",
            detail: `${sourcePrefix}${objLabel}`.trim()
          };
        });
      } else if (acContext.type === 'field') {
        const fields = await window.fetchObjectFields(acContext.objectName);
        suggestions = fields.flatMap(field => {
          // For relationship fields, add both the ID field and the relationship name
          if (field.isRelationship && field.relationshipName) {
            const relationshipDetail = `${field.label || field.relationshipName} → ${field.referenceTo.join(', ')}`;
            return [
              // The Id field (e.g., OwnerId) - just a regular field
              {
                label: field.name,
                type: "property",
                detail: field.label || field.type,
                info: field.type
              },
              // The relationship name (e.g., Owner) - shows relationship
              {
                label: field.relationshipName,
                type: "namespace",
                detail: relationshipDetail,
                info: 'relationship'
              }
            ];
          }
          
          // Regular fields
          return [{
            label: field.name,
            type: "property",
            detail: field.label || field.type,
            info: field.type
          }];
        });
      } else if (acContext.type === 'relationship-field') {
        const baseFields = await window.fetchObjectFields(acContext.baseObjectName);
        const relationshipField = baseFields.find(f => 
          f.relationshipName && f.relationshipName.toLowerCase() === acContext.relationshipName.toLowerCase()
        );
        
        if (relationshipField && relationshipField.referenceTo && relationshipField.referenceTo.length > 0) {
          const relatedObjectName = relationshipField.referenceTo[0];
          const relatedFields = await window.fetchObjectFields(relatedObjectName);
          suggestions = relatedFields.flatMap(field => {
            // For relationship fields, add both the ID field and the relationship name
            if (field.isRelationship && field.relationshipName) {
              const relationshipDetail = `${field.label || field.relationshipName} → ${field.referenceTo.join(', ')}`;
              return [
                // The Id field (e.g., OwnerId) - just a regular field
                {
                  label: field.name,
                  type: "property",
                  detail: field.label || field.type,
                  info: field.type
                },
                // The relationship name (e.g., Owner) - shows relationship
                {
                  label: field.relationshipName,
                  type: "namespace",
                  detail: relationshipDetail,
                  info: 'relationship'
                }
              ];
            }
            
            // Regular fields
            return [{
              label: field.name,
              type: "property",
              detail: field.label || field.type,
              info: field.type
            }];
          });
        }
      } else if (acContext.type === 'multi-relationship-field') {
        // Handle multi-level relationships like Profile.CreatedBy.Name
        let currentObjectName = acContext.baseObjectName;
        
        // Traverse the relationship path to find the final object
        for (const relName of acContext.relationshipPath) {
          const fields = await window.fetchObjectFields(currentObjectName);
          const relField = fields.find(f => 
            f.relationshipName && f.relationshipName.toLowerCase() === relName.toLowerCase()
          );
          
          if (!relField || !relField.referenceTo || relField.referenceTo.length === 0) {
            return null; // Can't traverse further
          }
          
          currentObjectName = relField.referenceTo[0];
        }
        
        // Now fetch fields from the final object
        const finalFields = await window.fetchObjectFields(currentObjectName);
        suggestions = finalFields.flatMap(field => {
          // For relationship fields, add both the ID field and the relationship name
          if (field.isRelationship && field.relationshipName) {
            const relationshipDetail = `${field.label || field.relationshipName} → ${field.referenceTo.join(', ')}`;
            return [
              // The Id field (e.g., OwnerId) - just a regular field
              {
                label: field.name,
                type: "property",
                detail: field.label || field.type,
                info: field.type
              },
              // The relationship name (e.g., Owner) - shows relationship
              {
                label: field.relationshipName,
                type: "namespace",
                detail: relationshipDetail,
                info: 'relationship'
              }
            ];
          }
          
          // Regular fields
          return [{
            label: field.name,
            type: "property",
            detail: field.label || field.type,
            info: field.type
          }];
        });
      }
      
      if (suggestions.length === 0) return null;
      
      // Filter by prefix using substring matching
      const prefix = acContext.prefix.toLowerCase();
      const filtered = suggestions.filter(s => s.label.toLowerCase().includes(prefix));
      
      if (filtered.length === 0) return null;
      
      // Calculate the position to replace (from start of prefix to cursor)
      const from = cursorPos - acContext.prefix.length;
      
      // For REST API syntax, wrap field names in quotes and add colon for value entry
      if (acContext.isRest) {
        // Check if there's already an opening quote before the insertion point
        const charBeforeFrom = from > 0 ? text[from - 1] : '';
        const hasQuoteBefore = charBeforeFrom === '"' || charBeforeFrom === "'";
        
        filtered.forEach(item => {
          // For relationship fields, add opening brace for nested object
          if (item.type === "namespace") {
            const insertText = hasQuoteBefore ? `${item.label}": { ` : `"${item.label}": { `;
            item.apply = (view, completion, from, to) => {
              view.dispatch({
                changes: {from, to, insert: insertText},
                selection: {anchor: from + insertText.length}
              });
              // Trigger autocomplete after inserting the opening brace
              startCompletion(view);
            };
          } else {
            item.apply = hasQuoteBefore ? `${item.label}": ` : `"${item.label}": `;
          }
        });
      }
      
      return {
        from: from,
        options: filtered
      };
    } catch (error) {
      console.error('Autocomplete error:', error);
      return null;
    }
  };
  
  const state = EditorState.create({
    doc: "",
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection({ drawRangeCursor: true }),
      EditorView.contentAttributes.of({ spellcheck: "false" }),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      EditorState.languageData.of(() => [{ autocomplete: soqlAutocompletion }]),
      rectangularSelection(),
      crosshairCursor(),
      //highlightActiveLine(),
      //highlightSelectionMatches(),
      sql(),
      json(),
      slashCommentPlugin,
      restSyntaxPlugin,
      autocompletion({ 
        override: [soqlAutocompletion],
        activateOnTyping: true,
        closeOnBlur: true,
        maxRenderedOptions: 500,
        optionClass: (completion) => {
          return completion.type === "namespace" ? "cm-completion-relationship" : "";
        }
      }),
      syntaxHighlighting(customHighlightStyle),
      keymap.of([
        {
          key: "Alt-Shift-f",
          run: formatSelection
        },
        {
          key: "Mod-Shift-f",
          run: formatSelection
        },
        // Custom key handlers for autocomplete
        {
          key: "Tab",
          run: (view) => {
            // Accept autocomplete if open
            if (acceptCompletion(view)) {
              return true;
            }
            return false;
          }
        },
        {
          key: "Enter",
          run: (view) => {
            // If autocomplete is open, accept selection
            if (acceptCompletion(view)) {
              return true;
            }
            // Otherwise just insert newline without indentation
            view.dispatch(view.state.replaceSelection("\n"));
            return true;
          }
        },
        {
          key: ".",
          run: (view) => {
            if (acceptCompletion(view)) {
              view.dispatch(view.state.replaceSelection("."));
              startCompletion(view);
              return true;
            }
            return false;
          }
        },
        {
          key: ",",
          run: (view) => {
            if (acceptCompletion(view)) {
              view.dispatch(view.state.replaceSelection(", "));
              return true;
            }
            return false;
          }
        },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap
      ]),
      EditorView.baseTheme({
        "&.cm-editor.cm-focused": {
          outline: "none"
        },
        ".cm-scroller": {
          overflow: "auto"
        },
        ".cm-selectionBackground": {
          backgroundColor: "#b3d7ff !important"
        },
        "&.cm-focused .cm-selectionBackground": {
          backgroundColor: "#ffeb3b !important"
        },
        ".cm-tooltip.cm-tooltip-autocomplete": {
          maxHeight: "none !important"
        }
      }),
      EditorView.theme({
        "&": {
          height: "100%",
          fontSize: "14px",
          backgroundColor: "#fff"
        },
        ".cm-content": {
          fontFamily: "monospace",
          padding: "8px 0",
          caretColor: "#000"
        },
        ".cm-comment": {
          color: "#9ccc9c"
        },
        ".cm-rest-object": {
          color: "#d73a49",
          fontWeight: "bold"
        },
        ".cm-tooltip.cm-tooltip-autocomplete": {
          minHeight: "50px",
          minWidth: "150px",
          width: "400px",
          height: "300px",
          overflow: "hidden !important",
          display: "flex !important",
          flexDirection: "column !important",
          position: "fixed !important"
        },
        ".cm-tooltip.cm-tooltip-autocomplete.cm-tooltip-above": {
          maxHeight: "none !important"
        },
        ".cm-tooltip.cm-tooltip-autocomplete.cm-tooltip-below": {
          maxHeight: "none !important"
        },
        ".cm-tooltip.cm-tooltip-autocomplete > ul": {
          flex: "1 1 auto !important",
          overflow: "auto !important",
          minHeight: "0 !important",
          maxHeight: "none !important",
          margin: "0 !important",
          padding: "0 !important",
          boxSizing: "border-box !important"
        },
        ".cm-tooltip.cm-tooltip-autocomplete .cm-completionList": {
          flex: "1 1 auto !important",
          overflow: "auto !important",
          minHeight: "0 !important",
          maxHeight: "none !important",
          boxSizing: "border-box !important",
          padding: "0 !important"
        },
        ".cm-tooltip.cm-tooltip-autocomplete .cm-completionList li": {
          boxSizing: "border-box !important"
        },
        ".cm-completionIcon": {
          display: "none"
        },
        ".cm-completion-relationship": {
          backgroundColor: "#e6f3ff",
          borderLeft: "3px solid #0066cc",
          paddingLeft: "8px"
        },
        ".cm-completion-relationship[aria-selected='true']": {
          backgroundColor: "#0066cc !important"
        },
        ".cm-panel.cm-search": {
          background: "#fff",
          border: "2px solid #0066cc",
          borderRadius: "4px",
          padding: "8px",
          boxShadow: "0 2px 8px rgba(0,0,0,0.2)"
        },
        ".cm-search input, .cm-search button, .cm-search label": {
          fontSize: "12px"
        },
        ".cm-search input": {
          border: "1px solid #ccc",
          padding: "4px",
          marginRight: "4px"
        },
        ".cm-search button": {
          background: "#0066cc",
          color: "white",
          border: "none",
          padding: "4px 8px",
          cursor: "pointer",
          borderRadius: "3px"
        },
        ".cm-search button:hover": {
          background: "#0052a3"
        },
        ".cm-gutters": {
          backgroundColor: "#f5f5f5",
          color: "#999",
          border: "none"
        },
        ".cm-activeLineGutter": {
          backgroundColor: "#e8f2ff"
        },
        ".cm-activeLine": {
          backgroundColor: "#f0f8ff"
        },
        ".cm-selectionMatch": {
          backgroundColor: "#99ff99"
        },
        ".cm-cursor": {
          borderLeftColor: "#000"
        }
      })
    ]
  });

  return new EditorView({
    state,
    parent
  });
};
