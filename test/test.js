'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const uglifyES = require('uglify-es');

const here = path.dirname(module.filename);
const suffix = process.env.TEST_COV ? '-cov' : '';
const unbrowserify = require(`../unbrowserify${suffix}`);
const decompress = require(`../decompress${suffix}`);

function parseString(code, filename) {
    const ast = uglifyES.minify({[filename]: code}, {
        parse: {},
        compress: false,
        mangle: false,
        output: {
            ast: true,
            code: false  // optional - faster if false
        }
    }).ast;
    ast.figure_out_scope();
    return ast;
}

function formatCode(ast) {
    return ast.print_to_string({
        beautify: true,
        ascii_only: true,
        bracketize: true
    });
}

Object.values = obj => {
    let key;
    const values = [];
    for (key in obj) {
        if (obj.hasOwnProperty(key)) {
            values.push(obj[key]);
        }
    }
    return values;
};

describe('unbrowserify', () => {
    describe('formatCode', () => {
        it('should output each var on a new line', () => {
            const ast = parseString('var a = 1, b = 2, c = 3;');
            assert.equal(formatCode(ast), 'var a = 1,\n    b = 2,\n    c = 3;');
        });

        it('should keep vars in a for on the same line', () => {
            const ast = parseString('for (var i = 0, j = 0; ;) {}');
            assert.equal(formatCode(ast), 'for (var i = 0, j = 0; ;) {}');
        });
    });

    describe('findMainFunction', () => {
        it('should find the main function', () => {
            const ast = parseString('var foo; !function e(){ }(foo);'), f = unbrowserify.findMainFunction(ast);

            assert.equal(f instanceof uglifyES.AST_Call, true);
            assert.equal(f.expression.name.name, 'e');
        });

        it('should throw if multiple main functions are found', () => {
            assert.throws(() => {
                const ast = parseString('var foo; !function e(){ }(foo); !function f(){ }(foo);');

                unbrowserify.findMainFunction(ast);
            });
        });

        it('should return undefined if no functions are defined', () => {
            const ast = parseString('var foo;'), f = unbrowserify.findMainFunction(ast);

            assert.equal(f, undefined);
        });
    });

    function extractHelper(bundleFilename, test) {
        const bundle = path.resolve(here, 'fib', bundleFilename), bundleSource = fs.readFileSync(bundle, 'utf8'), ast = parseString(bundleSource, bundle), mainFunction = unbrowserify.findMainFunction(ast), moduleObject = mainFunction.args[0], main = mainFunction.args[2], moduleNames = unbrowserify.extractModuleNames(moduleObject, main);

        test(moduleObject, moduleNames);
    }

    describe('extractModuleNames', () => {
        it('should find the module names', () => {
            extractHelper('bundle.js', (moduleObject, moduleNames) => {
                const modules = Object.values(moduleNames).sort();
                assert.deepEqual(modules, ['fib', 'main']);
            });
        });

        it('should find the module names after compression', () => {
            extractHelper('bundle-min.js', (moduleObject, moduleNames) => {
                const modules = Object.values(moduleNames).sort();
                assert.deepEqual(modules, ['fib', 'main']);
            });
        });
    });

    describe('extractModules', () => {
        const fib = path.resolve(here, 'fib', 'fib.js'), fibSource = fs.readFileSync(fib, 'utf8'), expected = parseString(fibSource, fib);

        it('should find the modules', () => {
            extractHelper('bundle.js', (moduleObject, moduleNames) => {
                const modules = unbrowserify.extractModules(moduleObject, moduleNames);

                assert.ok(modules.main instanceof uglifyES.AST_Toplevel);
                assert.ok(modules.fib instanceof uglifyES.AST_Toplevel);

                /* Check round-trip. */
                assert.equal(formatCode(modules.fib), formatCode(expected));
            });
        });

        it('should find the modules after compression', () => {
            extractHelper('bundle-min.js', (moduleObject, moduleNames) => {
                const modules = unbrowserify.extractModules(moduleObject, moduleNames);

                assert.ok(modules.main instanceof uglifyES.AST_Toplevel);
                assert.ok(modules.fib instanceof uglifyES.AST_Toplevel);

                /* The code for the two modules is no longer equal, because it has been compressed. */
            });
        });
    });
});

describe('decompress', () => {
    const directory = path.resolve(here, 'decompress');

    function findTestFiles() {
        const isJs = /\.js$/;
        return fs.readdirSync(directory).filter(name => isJs.test(name));
    }

    function getTestCases(filename) {
        const code = fs.readFileSync(path.resolve(directory, filename), 'utf8');
        const ast = parseString(code, filename);
        let inTest = false;
        let testCase;
        const cases = [];
        let tw;

        tw = new uglifyES.TreeWalker(function (node, descend) {
            let name;

            if (node instanceof uglifyES.AST_LabeledStatement) {
                name = node.label.name;

                if (this.parent() instanceof uglifyES.AST_Toplevel) {
                    testCase = {name};
                    cases.push(testCase);
                    inTest = true;
                    descend();
                    inTest = false;
                    return true;
                }

                if (name === 'description') {
                    testCase[name] = node.body.start.value;
                    return true;
                }

                if (name === 'input' || name === 'expect') {
                    testCase[name] = node.body;
                    return true;
                }

                throw new Error(`Unsupported label '${name}' at line ${node.label.start.line}`);
            }

            if (!inTest && !(node instanceof uglifyES.AST_Toplevel)) {
                throw new Error(`Unsupported statement ${node.TYPE} at line ${node.start.line}`);
            }
        });
        ast.walk(tw);

        return cases;
    }

    findTestFiles().forEach(filename => {
        describe(filename, () => {
            getTestCases(filename).forEach(testCase => {
                it(testCase.description || testCase.name, () => {
                    let output, expect;

                    decompress(testCase.input);

                    output = formatCode(testCase.input);
                    expect = formatCode(testCase.expect);

                    assert.equal(output, expect);
                });
            });
        });
    });
});
