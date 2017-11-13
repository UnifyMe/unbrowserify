const uglifyES = require('uglify-es');
const _ = require('lodash');

const defaultOptions = {
    constants: true,
    sequences: true,
    conditionals: true
};

function asStatement(node) {
    if (node instanceof uglifyES.AST_Statement) {
        return node;
    }

    return new uglifyES.AST_SimpleStatement({ body: node });
}

function replaceInBlock(node, field, replace) {
    let newNodes;
    let body = node[field];
    const single = body instanceof uglifyES.AST_Node;

    if (body === null || body === undefined) {
        return;
    }

    if (single) {
        body = [body];
    }

    let i = 0;

    while (i < body.length) {
        newNodes = replace(body[i], i, body);

        if (newNodes) {
            newNodes.unshift(i, 1);

            Array.prototype.splice.apply(body, newNodes);
        } else {
            i += 1;
        }
    }

    if (single) {
        if (body.length === 1) {
            node[field] = body[0];
        } else {
            node[field] = new uglifyES.AST_BlockStatement({body});
        }
    }
}

function removeSequences(node, field) {
    const nodeTypes = [
        { type: uglifyES.AST_Return, field: 'value' },
        { type: uglifyES.AST_SimpleStatement, field: 'body' },
        { type: uglifyES.AST_If, field: 'condition' },
        { type: uglifyES.AST_For, field: 'init' },
        { type: uglifyES.AST_With, field: 'expression' },
        { type: uglifyES.AST_Switch, field: 'expression' }
    ];

    replaceInBlock(node, field, child => {
        let j, seq;

        if (child instanceof uglifyES.AST_Var) {
            const resolvedChildDefinition = child.definitions.find(childDefinition =>
                childDefinition.value instanceof uglifyES.AST_Sequence
            );

            if (resolvedChildDefinition) {
                seq = resolvedChildDefinition.value;
                resolvedChildDefinition.value = seq.cdr;

                return [new uglifyES.AST_SimpleStatement({body: seq.car}), child];
            }
        }

        if (child instanceof uglifyES.AST_SimpleStatement &&
                child.body instanceof uglifyES.AST_Assign &&
                child.body.right instanceof uglifyES.AST_Sequence) {
            seq = child.body.right;
            child.body.right = seq.cdr;
            return [new uglifyES.AST_SimpleStatement({body: seq.car}), child];
        }

        const resolvedNodeType = nodeTypes.find(nodeType =>
            child instanceof nodeType.type
            && child[nodeType.field] instanceof uglifyES.AST_Sequence
        );

        if (!resolvedNodeType) return;

        seq = child[resolvedNodeType.field];
        child[resolvedNodeType.field] = seq.cdr;

        return [new uglifyES.AST_SimpleStatement({body: seq.car}), child];
    });
}

function transformBefore(node) {
    if (this.options.constants) {
        /* 0/0 => NaN */
        if (node instanceof uglifyES.AST_Binary && node.operator === '/' &&
                node.left instanceof uglifyES.AST_Number && node.left.value === 0 &&
                node.right instanceof uglifyES.AST_Number && node.right.value === 0) {
            return new uglifyES.AST_NaN();
        }

        /* 1/0 => Infinity */
        if (node instanceof uglifyES.AST_Binary && node.operator === '/' &&
                node.left instanceof uglifyES.AST_Number && node.left.value === 1 &&
                node.right instanceof uglifyES.AST_Number && node.right.value === 0) {
            return new uglifyES.AST_Infinity();
        }

        /* !0 => true, !1 => false */
        if (node instanceof uglifyES.AST_UnaryPrefix && node.operator === '!' &&
                node.expression instanceof uglifyES.AST_Number) {
            if (node.expression.value === 0) {
                return new uglifyES.AST_True();
            }
            if (node.expression.value === 1) {
                return new uglifyES.AST_False();
            }
        }
    }

    if (this.options.sequences) {
        if (node instanceof uglifyES.AST_Block) {
            removeSequences(node, 'body');
        } else if (node instanceof uglifyES.AST_StatementWithBody) {
            removeSequences(node, 'body');
            if (node instanceof uglifyES.AST_If) {
                removeSequences(node, 'alternative');
            }
        }
    }

    if (this.options.conditionals) {
        if (node instanceof uglifyES.AST_SimpleStatement && node.body instanceof uglifyES.AST_Binary) {
            /* a && b; => if (a) { b; } */
            if (node.body.operator === '&&') {
                node = new uglifyES.AST_If({
                    condition: node.body.left,
                    body: asStatement(node.body.right),
                    alternative: null
                });
                node.transform(this);
                return node;
            }
            /* a || b; => if (!a) { b; } */
            if (node.body.operator === '||') {
                node = new uglifyES.AST_If({
                    condition: new uglifyES.AST_UnaryPrefix({operator: '!', expression: node.body.left}),
                    body: asStatement(node.body.right),
                    alternative: null
                });
                node.transform(this);
                return node;
            }
        }

        /* a ? b : c; => if (a) { b; } else { c; } */
        if (node instanceof uglifyES.AST_SimpleStatement && node.body instanceof uglifyES.AST_Conditional) {
            node = new uglifyES.AST_If({
                condition: node.body.condition,
                body: asStatement(node.body.consequent),
                alternative: asStatement(node.body.alternative)
            });
            node.transform(this);
            return node;
        }

        /* return a ? b : c; => if (a) { return b; } else { return c; } */
        if (node instanceof uglifyES.AST_Return && node.value instanceof uglifyES.AST_Conditional) {
            node = new uglifyES.AST_If({
                condition: node.value.condition,
                body: new uglifyES.AST_Return({ value: node.value.consequent }),
                alternative: new uglifyES.AST_Return({ value: node.value.alternative })
            });
            node.transform(this);
            return node;
        }

        /* return void a(); => a(); return; */
        if (node instanceof uglifyES.AST_Block || node instanceof uglifyES.AST_StatementWithBody) {
            replaceInBlock(node, 'body', child => {
                if (child instanceof uglifyES.AST_Return &&
                        child.value instanceof uglifyES.AST_UnaryPrefix &&
                        child.value.operator === 'void') {
                    return [new uglifyES.AST_SimpleStatement({ body: child.value.expression }),
                            new uglifyES.AST_Return({ value: null }) ];
                }
            });
        }
    }
}

function decompress(node, userOptions) {
    let k, transform;

    const options = _.defaults({}, userOptions, defaultOptions);

    transform = new uglifyES.TreeTransformer(transformBefore);
    transform.options = options;
    node.transform(transform);
}

module.exports = decompress;
