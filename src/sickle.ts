import * as ts from 'typescript';

export interface SickleOptions {
  // If true, convert every type to the Closure {?} type, which means
  // "don't check types".
  untyped?: boolean;
}

export interface SickleOutput {
  // The TypeScript source with Closure annotations inserted.
  output: string;
  // Generated externs declarations, if any.
  externs: string;
  // Error messages, if any.
  diagnostics: ts.Diagnostic[];
}

/** The compiler options used by the test suite and sickle command line. */
export const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES6,
  noImplicitAny: true,
  skipDefaultLibCheck: true,
  noEmitOnError: true,
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
};

export function formatDiagnostics(diags: ts.Diagnostic[]): string {
  return diags.map((d) => {
                let res = ts.DiagnosticCategory[d.category];
                if (d.file) {
                  res += ' at ' + d.file.fileName + ':';
                  let {line, character} = d.file.getLineAndCharacterOfPosition(d.start);
                  res += (line + 1) + ':' + (character + 1) + ':';
                }
                res += ' ' + d.messageText;
                return res;
              })
      .join('\n');
}

/**
 * TypeScript has an API for JSDoc already, but it's not exposed.
 * https://github.com/Microsoft/TypeScript/issues/7393
 * For now we create types that are similar to theirs so that migrating
 * to their API will be easier.  See e.g. ts.JSDocTag and ts.JSDocComment.
 */
export interface JSDocTag {
  // tagName is e.g. "param" in an @param declaration.  It's absent
  // for the plain text documentation that occurs before any @foo lines.
  tagName?: string;
  // parameterName is the the name of the function parameter, e.g. "foo"
  // in
  //   @param foo The foo param.
  parameterName?: string;
  type?: ts.TypeNode;
  // optional is true for optional function parameters.
  optional?: boolean;
  text?: string;
}

export interface JSDocComment { tags: JSDocTag[]; }

/**
 * getJSDocAnnotation parses JSDoc out of a comment string.
 * Returns null if comment is not JSDoc.
 */
export function getJSDocAnnotation(comment: string): JSDocComment {
  // TODO(evanm): this is a pile of hacky regexes for now, because we
  // would rather use the better TypeScript implementation of JSDoc
  // parsing.  https://github.com/Microsoft/TypeScript/issues/7393
  let match = comment.match(/^\/\*\*([\s\S]*?)\*\/$/);
  if (!match) return null;
  comment = match[1].trim();
  // Strip all the " * " bits from the front of each line.
  comment = comment.replace(/^\s*\* /gm, '');
  let lines = comment.split('\n');
  let tags: JSDocTag[] = [];
  for (let line of lines) {
    let match = line.match(/^@(\S+) *(.*)/);
    if (match) {
      let [_, tagName, text] = match;
      if (tagName == 'type') {
        throw new Error('@type annotations are not allowed');
      }
      if ((tagName == 'param' || tagName == 'return') && text[0] == '{') {
        throw new Error('type annotations (using {...}) are not allowed');
      }

      // Grab the parameter name from @param tags.
      let parameterName: string;
      if (tagName === 'param') {
        let match = text.match(/^(\S+) ?(.*)/);
        if (match) [_, parameterName, text] = match;
      }

      let tag: JSDocTag = {tagName};
      if (parameterName) tag.parameterName = parameterName;
      if (text) tag.text = text;
      tags.push(tag);
    } else {
      // Text without a preceding @tag on it is either the plain text
      // documentation or a continuation of a previous tag.
      if (tags.length === 0) {
        tags.push({text: line.trim()});
      } else {
        tags[tags.length - 1].text += ' ' + line.trim();
      }
    }
  }
  return {tags};
}

const VISIBILITY_FLAGS = ts.NodeFlags.Private | ts.NodeFlags.Protected | ts.NodeFlags.Public;

/**
 * A source processor that takes TypeScript code and annotates the output with Closure-style JSDoc
 * comments.
 */
class Annotator {
  /** The primary annotated TypeScript output, as an array of strings. */
  private tsOutput: string[] = [];
  /** Output for the externs.js file. */
  private externsOutput: string[] = [];
  /** The current output, either tsOutput or externsOutput. */
  private currentOutput: string[] = this.tsOutput;
  /** Warnings/errors found while examining the code. */
  private diagnostics: ts.Diagnostic[] = [];

  /**
   * The current level of recursion through TypeScript Nodes.  Used in formatting internal debug
   * print statements.
   */
  private indent: number = 0;
  /** The node currently being visited by visit(). This is only used in error messages. */
  private currentNode: ts.Node;

  constructor(
      private program: ts.Program, private file: ts.SourceFile, private options: SickleOptions) {}

  annotate(): SickleOutput {
    this.visit(this.file);
    this.assert(this.indent == 0, 'visit() failed to track nesting');
    return {
      output: this.tsOutput.join(''),
      externs: this.externsOutput.length > 0 ? this.externsOutput.join('') : null,
      diagnostics: this.diagnostics,
    };
  }

  private emit(str: string) { this.currentOutput.push(str); }

  private logWithIndent(message: string) {
    let prefix = new Array(this.indent + 1).join('| ');
    console.log(prefix + message);
  }

  private visit(node: ts.Node) {
    this.currentNode = node;
    // this.logWithIndent('node: ' + ts.SyntaxKind[node.kind]);
    this.indent++;

    if (node.flags & ts.NodeFlags.Ambient) {
      this.visitExterns(node);
      // An ambient declaration declares types for TypeScript's benefit, so we want to skip Sickle
      // conversion of its contents.
      this.writeRange(node.getFullStart(), node.getEnd());
    } else {
      switch (node.kind) {
        case ts.SyntaxKind.ExportDeclaration:
          let exportDecl = <ts.ExportDeclaration>node;
          if (!exportDecl.exportClause && exportDecl.moduleSpecifier) {
            // It's an "export * from ..." statement.
            // Rewrite it to re-export each exported symbol directly.
            let typeChecker = this.program.getTypeChecker();
            let exports = typeChecker.getExportsOfModule(
                typeChecker.getSymbolAtLocation(exportDecl.moduleSpecifier));

            // Avoid reexporting any names that are already locally exported.
            let locals = typeChecker.getSymbolsInScope(this.file, ts.SymbolFlags.Export);
            let localSet: {[name: string]: boolean} = {};
            for (let local of locals) {
              localSet[local.name] = true;
            }
            exports = exports.filter(e => !localSet.hasOwnProperty(e.name));

            this.emit('export {');
            this.emit(exports.map(e => e.name).join(','));
            this.emit('} from');
            this.writeRange(exportDecl.moduleSpecifier.getFullStart(), node.getEnd());
          } else {
            this.writeNode(node);
          }
          break;
        case ts.SyntaxKind.InterfaceDeclaration:
          let decl = <ts.InterfaceDeclaration>node;
          this.writeRange(node.getFullStart(), node.getEnd());
          break;
        case ts.SyntaxKind.VariableDeclaration:
          this.maybeEmitJSDocType((<ts.VariableDeclaration>node).type);
          this.writeNode(node);
          break;
        case ts.SyntaxKind.ClassDeclaration:
          let classNode = <ts.ClassDeclaration>node;
          if (classNode.members.length > 0) {
            // We must visit all members individually, to strip out any
            // /** @export */ annotations that show up in the constructor
            // and to annotate methods.
            this.writeTextBetween(classNode, classNode.members[0]);
            for (let member of classNode.members) {
              this.visit(member);
            }
          } else {
            this.writeTextBetween(classNode, classNode.getLastToken());
          }
          this.emitTypeAnnotationsHelper(classNode);
          this.writeNode(classNode.getLastToken());
          break;
        case ts.SyntaxKind.PublicKeyword:
        case ts.SyntaxKind.PrivateKeyword:
          // The "public"/"private" keywords are encountered in two places:
          // 1) In class fields (which don't appear in the transformed output).
          // 2) In "parameter properties", e.g.
          //      constructor(/** @export */ public foo: string).
          // In case 2 it's important to not emit that JSDoc in the generated
          // constructor, as this is illegal for Closure.  It's safe to just
          // always skip comments preceding the 'public' keyword.
          // See test_files/parameter_properties.ts.
          this.writeNode(node, /* skipComments */ true);
          break;
        case ts.SyntaxKind.Constructor:
          let ctor = <ts.ConstructorDeclaration>node;
          this.emitFunctionType(ctor);
          // Write the "constructor(...) {" bit, but iterate through any
          // parameters if given so that we can examine them more closely.
          let offset = ctor.getStart();
          if (ctor.parameters.length) {
            for (let param of ctor.parameters) {
              this.writeTextFromOffset(offset, param);
              this.visit(param);
              offset = param.getEnd();
            }
          }
          this.writeRange(offset, node.getEnd());
          break;
        case ts.SyntaxKind.ArrowFunction:
          if (this.options.untyped) {
            // In untyped mode, don't emit any type before the arrow function.
            // Works around issue #57.
            this.writeNode(node);
            break;
          }
        // Otherwise, fall through to the shared processing for function.
        case ts.SyntaxKind.FunctionDeclaration:
        case ts.SyntaxKind.MethodDeclaration:
          let fnDecl = <ts.FunctionLikeDeclaration>node;

          if (!fnDecl.body) {
            // Functions are allowed to not have bodies in the presence
            // of overloads.  It's not clear how to translate these overloads
            // into Closure types, so skip them for now.
            this.writeNode(node);
            break;
          }

          this.emitFunctionType(fnDecl);
          this.writeTextFromOffset(fnDecl.getStart(), fnDecl.body);
          this.visit(fnDecl.body);
          break;
        case ts.SyntaxKind.TypeAliasDeclaration:
          this.visitTypeAlias(<ts.TypeAliasDeclaration>node);
          this.writeNode(node);
          break;
        case ts.SyntaxKind.EnumDeclaration:
          this.visitEnum(<ts.EnumDeclaration>node);
          break;
        case ts.SyntaxKind.TypeAssertionExpression:
          let typeAssertion = <ts.TypeAssertion>node;
          this.maybeEmitJSDocType(typeAssertion.type);
          this.emit('(');
          this.writeNode(node);
          this.emit(')');
          break;
        default:
          this.writeNode(node);
          break;
      }
    }

    this.indent--;
  }

  private emitFunctionType(fnDecl: ts.FunctionLikeDeclaration) {
    // Construct the JSDoc comment by reading the existing JSDoc, if
    // any, and merging it with the known types of the function
    // parameters and return type.
    let jsDoc = this.getJSDoc(fnDecl) || {tags: []};
    let newDoc: JSDocComment = {tags: []};

    // Copy all the tags other than @param/@return into the new
    // comment without any change; @param/@return are handled later.
    for (let tag of jsDoc.tags) {
      if (tag.tagName === 'param' || tag.tagName === 'return') continue;
      newDoc.tags.push(tag);
    }

    // Parameters.
    if (fnDecl.parameters.length) {
      for (let param of fnDecl.parameters) {
        let name = param.name.getText();
        let paramDoc: string;
        // Search for this parameter in the JSDoc @params.
        for (let { tagName, parameterName, text } of jsDoc.tags) {
          if (tagName === 'param' && parameterName === name) {
            paramDoc = text;
            break;
          }
        }
        newDoc.tags.push({
          tagName: 'param',
          parameterName: name,
          type: param.type,
          optional: param.initializer != null || param.questionToken != null,
          text: paramDoc,
        });
      }
    }

    // Return type.
    if (fnDecl.type) {
      let returnDoc: string;
      for (let { tagName, text } of jsDoc.tags) {
        if (tagName === 'return') {
          returnDoc = text;
          break;
        }
      }
      newDoc.tags.push({
        tagName: 'return',
        type: fnDecl.type,
        text: returnDoc,
      });
    }

    // The first \n makes the output sometimes uglier than necessary,
    // but it's needed to work around
    // https://github.com/Microsoft/TypeScript/issues/6982
    this.emit('\n/**\n');
    for (let tag of newDoc.tags) {
      this.emit(' * ');
      if (tag.tagName) {
        this.emit(`@${tag.tagName}`);
      }
      if (tag.type) {
        this.emit(' {');
        this.emitType(tag.type, tag.optional);
        this.emit('}');
      }
      if (tag.parameterName) {
        this.emit(' ' + tag.parameterName);
      }
      if (tag.text) {
        this.emit(' ' + tag.text);
      }
      this.emit('\n');
    }
    this.emit(' */\n');
  }

  // emitTypeAnnotationsHelper produces a
  // _sickle_typeAnnotationsHelper() where none existed in the
  // original source.  It's necessary in the case where TypeScript
  // syntax specifies there are additional properties on the class,
  // because to declare these in Closure you must declare these in a
  // method somewhere.
  private emitTypeAnnotationsHelper(classDecl: ts.ClassDeclaration) {
    // Gather parameter properties from the constructor, if it exists.
    let paramProps: ts.ParameterDeclaration[] = [];
    let ctors = classDecl.members.filter((e) => e.kind === ts.SyntaxKind.Constructor);
    if (ctors && ctors.length > 0) {
      let ctor = <ts.ConstructorDeclaration>ctors[0];
      paramProps = ctor.parameters.filter((p) => !!(p.flags & VISIBILITY_FLAGS));
    }

    // Gather other non-static properties on the class.
    let nonStaticProps = <ts.PropertyDeclaration[]>(classDecl.members.filter((e) => {
      let isStatic = (e.flags & ts.NodeFlags.Static) !== 0;
      let isProperty = e.kind === ts.SyntaxKind.PropertyDeclaration;
      return !isStatic && isProperty;
    }));

    if (nonStaticProps.length == 0 && paramProps.length == 0) {
      // There are no members so we don't need to emit any type
      // annotations helper.
      return;
    }

    this.emit('\n\n  static _sickle_typeAnnotationsHelper() {\n');
    nonStaticProps.forEach((p) => this.visitProperty(classDecl.name.text, p));
    paramProps.forEach((p) => this.visitProperty(classDecl.name.text, p));
    this.emit('  }\n');
  }

  private visitProperty(className: string, p: ts.PropertyDeclaration | ts.ParameterDeclaration) {
    let jsDoc = this.getJSDoc(p) || {tags: []};
    let existingAnnotation = '';
    for (let { tagName, text } of jsDoc.tags) {
      if (tagName) {
        existingAnnotation += `@${tagName}\n`;
      } else {
        existingAnnotation += `${text}\n`;
      }
    }
    this.maybeEmitJSDocType(p.type, existingAnnotation + '@type');
    this.emit(`\n    ${className}.prototype.${p.name.getText()};\n`);
  }

  /**
   * Returns null if there is no existing comment.
   */
  private getJSDoc(node: ts.Node): JSDocComment {
    let text = node.getFullText();
    let comments = ts.getLeadingCommentRanges(text, 0);

    if (!comments || comments.length == 0) return null;

    // JS compiler only considers the last comment significant.
    let {pos, end} = comments[comments.length - 1];
    let comment = text.substring(pos, end);
    try {
      return getJSDocAnnotation(comment);
    } catch (e) {
      this.diagnostics.push({
        file: this.file,
        start: node.getFullStart() + pos,
        length: end - pos,
        messageText: e.message,
        category: ts.DiagnosticCategory.Error,
        code: undefined,
      });
      return null;
    }
  }

  private visitExterns(node: ts.Node, namespace: string[] = []) {
    this.currentOutput = this.externsOutput;
    switch (node.kind) {
      case ts.SyntaxKind.ModuleDeclaration:
        let decl = <ts.ModuleDeclaration>node;
        namespace = namespace.concat([decl.name.text]);
        this.visitExterns(decl.body, namespace);
        break;
      case ts.SyntaxKind.ModuleBlock:
        let block = <ts.ModuleBlock>node;
        for (let stmt of block.statements) {
          this.visitExterns(stmt, namespace);
        }
        break;
      case ts.SyntaxKind.InterfaceDeclaration:
        this.writeExternsInterface(<ts.InterfaceDeclaration>node, namespace);
        break;
      case ts.SyntaxKind.VariableStatement:
        for (let decl of(<ts.VariableStatement>node).declarationList.declarations) {
          this.writeExternsVariable(decl, namespace);
        }
        break;
      default:
        this.errorUnimplementedKind(node, 'externs generation');
        break;
    }
    this.currentOutput = this.tsOutput;
  }

  private writeExternsInterface(decl: ts.InterfaceDeclaration, namespace: string[]) {
    this.emit('/** @record @struct */\n');
    let className = namespace.concat([decl.name.getText()]).join('.');
    if (namespace.length > 0) {
      this.emit(`${className} = function() {};\n`);
    } else {
      this.emit(`function ${className}() {}\n`);
    }
    for (let member of decl.members) {
      switch (member.kind) {
        case ts.SyntaxKind.PropertySignature:
          let prop = <ts.PropertySignature>member;
          this.maybeEmitJSDocType(prop.type, '@type');
          this.emit(`\n${className}.prototype.${prop.name.getText()};\n`);
          break;
        default:
          // Members can include things like index signatures, for e.g.
          //   interface Foo { [key: string]: number; }
          // For now, just die unless all the members are regular old
          // properties.
          this.errorUnimplementedKind(member, 'externs for interface');
      }
    }
  }

  private writeExternsVariable(decl: ts.VariableDeclaration, namespace: string[]) {
    if (decl.name.kind === ts.SyntaxKind.Identifier) {
      let identifier = <ts.Identifier>decl.name;
      this.maybeEmitJSDocType(decl.type, '@type');
      if (namespace.length > 0) {
        let qualfiedName = namespace.concat([identifier.text]).join('.');
        this.emit(`\n${qualfiedName};\n`);
      } else {
        this.emit(`\nvar ${identifier.text};\n`);
      }
    } else {
      this.errorUnimplementedKind(decl.name, 'externs for variable');
    }
  }

  private maybeEmitJSDocType(type: ts.TypeNode, jsDocTag?: string) {
    if (!type && !this.options.untyped) return;
    this.emit(' /**');
    if (jsDocTag) {
      this.emit(' ');
      this.emit(jsDocTag);
      this.emit(' {');
    }
    this.emitType(type);
    if (jsDocTag) {
      this.emit('}');
    }
    this.emit(' */');
  }

  private emitType(type: ts.TypeNode, optional?: boolean) {
    if (this.options.untyped) {
      this.emit(' ?');
    } else {
      this.visit(type);
    }
    if (optional) {
      this.emit('=');
    }
  }

  private visitTypeAlias(node: ts.TypeAliasDeclaration) {
    if (this.options.untyped) return;
    // Write a Closure typedef, which involves an unused "var" declaration.
    this.emit('/** @typedef {');
    this.visit(node.type);
    this.emit('} */\n');
    this.emit('var ');
    this.emit(node.name.getText());
    this.emit(': void;\n');
  }

  private visitEnum(node: ts.EnumDeclaration) {
    if (!this.options.untyped) this.emit('/** @typedef {number} */\n');
    this.writeNode(node);
    this.emit('\n');
    let i = 0;
    for (let member of node.members) {
      if (!this.options.untyped) this.emit(`/** @type {${node.name.getText()}} */\n`);
      this.emit(`(<any>${node.name.getText()}).${member.name.getText()} = `);
      if (member.initializer) {
        this.visit(member.initializer);
      } else {
        this.emit(String(i));
        i++;
      }
      this.emit(';\n');
    }
  }

  private writeNode(node: ts.Node, skipComments: boolean = false) {
    if (node.getChildCount() == 0) {
      // Directly write complete tokens.
      if (skipComments) {
        // To skip comments, we skip all whitespace/comments preceding
        // the node.  But if there was anything skipped we should emit
        // a newline in its place so that the node remains separated
        // from the previous node.  TODO: don't skip anything here if
        // there wasn't any comment.
        if (node.getFullStart() < node.getStart()) {
          this.emit('\n');
        }
        this.emit(node.getText());
      } else {
        this.emit(node.getFullText());
      }
      return;
    }
    if (skipComments) {
      this.fail('skipComments unimplemented for complex Nodes');
    }
    let lastEnd = node.getFullStart();
    for (let child of node.getChildren()) {
      this.writeTextFromOffset(lastEnd, child);
      this.visit(child);
      lastEnd = child.getEnd();
    }
    // Write any trailing text.
    this.writeRange(lastEnd, node.getEnd());
  }

  // Write a span of the input file as expressed by absolute offsets.
  // These offsets are found in attributes like node.getFullStart() and
  // node.getEnd().
  private writeRange(from: number, to: number): number {
    // getSourceFile().getText() is wrong here because it the text of
    // the SourceFile node of the AST, which doesn't contain the comments
    // preceding that node.  Semantically these ranges are just offsets
    // into the original source file text, so slice from that.
    let text = this.file.text.slice(from, to);
    if (text) this.emit(text);
    return to;
  }

  private writeTextBetween(node: ts.Node, to: ts.Node): number {
    return this.writeRange(node.getFullStart(), to.getFullStart());
  }

  private writeTextFromOffset(from: number, node: ts.Node): number {
    let to = node.getFullStart();
    if (from == to) return to;
    this.assert(to > from, `Offset must not be smaller; ${to} vs ${from}`);
    return this.writeRange(from, to);
  }

  /**
   * Produces a compiler error that references the Node's kind.  This is useful for the "else"
   * branch of code that is attempting to handle all possible input Node types, to ensure all cases
   * covered.
   */
  private errorUnimplementedKind(node: ts.Node, where: string) {
    this.error(node, `${ts.SyntaxKind[node.kind]} not implemented in ${where}`);
  }

  private error(node: ts.Node, messageText: string, start?: number, length?: number) {
    start = start || node.getStart();
    length = length || (node.getEnd() - node.getFullStart());
    this.diagnostics.push({
      file: this.file,
      start,
      length,
      messageText,
      category: ts.DiagnosticCategory.Error,
      code: undefined,
    });
  }

  /**
   * fail causes the current compilation to abort with an error message.
   * It should only be used for internal compiler errors; otherwise,
   * use this.error().
   */
  private fail(msg: string) {
    let offset = this.currentNode.getFullStart();
    let {line, character} = this.file.getLineAndCharacterOfPosition(offset);
    throw new Error(`near node starting at ${line+1}:${character+1}: ${msg}`);
  }

  private assert(condition: boolean, msg: string) {
    if (!condition) this.fail(msg);
  }
}

function last<T>(elems: T[]): T {
  return elems.length ? elems[elems.length - 1] : null;
}

export function annotate(
    program: ts.Program, file: ts.SourceFile, options: SickleOptions = {}): SickleOutput {
  return new Annotator(program, file, options).annotate();
}

// CLI entry point
if (require.main === module) {
  let paths = process.argv.splice(2);
  let program = ts.createProgram(paths, compilerOptions);
  let diags = ts.getPreEmitDiagnostics(program);
  if (diags.length > 0) {
    console.log(formatDiagnostics(diags));
    process.exit(1);
  }
  for (let path of paths) {
    console.log(annotate(program, program.getSourceFile(path)));
  }
}
