/*jslint node: true */
'use strict';

const Promise = require('bluebird');

const fs = Promise.promisifyAll(require('fs'));
const path = require('path');

const _ = require('lodash');
const uglifyES = require('uglify-es')
const decompress = require('./decompress');

const assert = require('assert');

/* Default options */

const outputOptions = {
    beautify: true,
    ascii_only: true,
    bracketize: true
};

/* Override printing of variable definitions to output each var on a separate line. */
uglifyES.AST_Definitions.prototype._do_print = function (output, kind) {
    var self = this,
        p = output.parent(),
        inFor = (p instanceof uglifyES.AST_For || p instanceof uglifyES.AST_ForIn) && p.init === this;

    output.print(kind);
    output.space();

    if (inFor) {
        this.definitions.forEach(function (def, i) {
            if (i !== 0) {
                output.comma();
            }
            def.print(output);
        });
    } else {
        output.with_indent(output.indentation() + 4, function () {
            self.definitions.forEach(function (def, i) {
                if (i !== 0) {
                    output.print(',');
                    output.newline();
                    output.indent();
                }

                def.print(output);
            });
        });

        output.semicolon();
    }
};

const parseFile = function* (filename) {
    const code = yield fs.readFileAsync(filename, 'utf8');

    const ast = uglifyJS.parse(code, {
        filename
    });

    ast.figure_out_scope();

    return ast;
};

function outputCode(ast, filename) {
    const code = ast.print_to_string(outputOptions);

    if (!filename) return console.log(code);

    return fs.writeFileAsync(filename, code);
}

const findMainFunction = ast => {
    let mainFunctionCall;

    const visitor = new uglifyES.TreeWalker(node => {
        if (node instanceof uglifyES.AST_Call) {
            assert(mainFunctionCall === undefined, 'More than one top-level function found.');

            mainFunctionCall = node;

            return true;
        }
    });

    ast.walk(visitor);

    return mainFunctionCall;
}

const extractModuleNames = (moduleObject, main) => {
    var moduleNames = {};

    main.elements.forEach(element => {
        moduleNames[element.value] = 'main';
    });

    moduleObject.properties.forEach(function (objectProperty) {
        var moduleId = objectProperty.key,
            moduleFunction = objectProperty.value.elements[0],
            requireMapping = objectProperty.value.elements[1];

        /* TODO: Resolve module names relative to output directory. */

        requireMapping.properties.forEach(function (prop) {
            var name = path.basename(prop.key, '.js'),
                id = prop.value.value;

            if (!moduleNames[id]) {
                moduleNames[id] = name;
            } else if (moduleNames[id].toLowerCase() !== name.toLowerCase()) {
                console.warn('More than one name found for module ' + id + ':');
                console.warn('    ' + moduleNames[id]);
                console.warn('    ' + name);
            }
        });
    });

    return moduleNames;
}

function renameArguments(moduleFunction) {
    var argNames = [
        'require', 'module', 'exports', 'moduleSource',
        'loadedModules', 'mainIds'
    ];

    /* Rename the function arguments (if needed). The code generator has
     * special logic to display the mangled name if it's present. */
    moduleFunction.argnames.forEach(function (arg, i) {
        if (arg.name !== argNames[i]) {
            if(arg.thedef == null) arg.thedef = {}
            arg.thedef.mangled_name = argNames[i];
        }
    });
}

function updateRequires(moduleFunction, mapping) {
    var visitor, name;

    visitor = new uglifyES.TreeWalker(node => {
        if (node instanceof uglifyES.AST_Call &&
                node.expression instanceof uglifyES.AST_SymbolRef &&
                (node.expression.name === 'require' ||
                 (node.expression.thedef && node.expression.thedef.mangled_name === 'require')) &&
                node.args.length === 1 &&
                node.args[0] instanceof uglifyES.AST_String) {

            name = path.basename(node.args[0].value, '.js');

            if (mapping[name]) {
                node.args[0].value = './' + mapping[name] + '.js';
            }
        }
    });

    moduleFunction.walk(visitor);
}

const resolveModulePaths = moduleDefinitions => {
    /* DAG archtitecture

        edge <---- visitor
          ^______/   |
                     |
            edge     |
              ^______/

        Map_edge -> Set -> visitors
    */

    // Map<key, Set<String>>
    const knownPaths = new Map();

    // Set<path, originName>
    const registerPathMapping = (moduleName, path) => {
        const knownPath = knownPaths.get(path);

        if (!knownPath) {
            return knownPaths.set(path, new Set([moduleName]));
        }

        knownPath.has(moduleName) || knownPath.add(moduleName);
    };

    // nop: resolve file paths
    moduleDefinitions.forEach(moduleDefinition => {
        const {moduleName, moduleMapping} = moduleDefinition;

        moduleMapping.forEach(([realPath, id]) => {
            registerPathMapping(moduleName, path);
        });
    });

    return moduleDefinitions.map(moduleDefinition => {
        const {moduleName, moduleMapping, moduleFunction} = moduleDefinition;

        const resolvedMapping = moduleMapping.map(([realPath, id]) => {
            return [path.basename(moduleName, '.js'), id]
        });

        return {moduleName, moduleFunction, moduleMapping: resolvedMapping};
    });
};

function extractModules(moduleObject, moduleNames) {
    const modules = {};

    modules.main = new uglifyES.AST_Toplevel({body: []});

    // moduleName moduleFunction
    const moduleProperties = moduleObject.properties.map(objectProperty => {
        const moduleId = objectProperty.key;
        const [moduleFunction, requireMapping] = objectProperty.value.elements;

        const moduleName = moduleNames[moduleId];

        let moduleMapping = [];

        requireMapping.properties.forEach(({key, value}) => {
            const rKey = path.basename(key, '.js');
            const id = value.value;

            moduleMapping.push([rKey, moduleNames[id]]);
        });

        return {moduleName, moduleFunction, moduleMapping};
    });

    //const resolvedModuleProperties = resolveModulePaths(moduleProperties);
    const resolvedModuleProperties = moduleProperties;

    resolvedModuleProperties.forEach(({moduleName, moduleFunction, moduleMapping}) => {
        const module = modules[moduleName] || new uglifyES.AST_Toplevel({body: []});

        modules[moduleName] = module;

        renameArguments(moduleFunction);
        updateRequires(moduleFunction, moduleMapping);

        modules[moduleName].body = [
            ...modules[moduleName].body,
            ...moduleFunction.body
        ];
    });

    return modules;
}

const unbrowserify = Promise.coroutine(function* (filename, outputDirectory) {
    const ast = yield* parseFile(filename);

    /*
     Top level of each file should be:

     function e(t, n, r){ ... }({ ... }, {}, [ ... ]);

     Where the omitted parts are:
     1) Top level implementation of `require`
     2) Module source
     3) Ids of the `main` module.

     The module source is an object literal, the key is the module's id,
     the value is an array containing the module function and a object
     literal of module name to id mappings.
     */

    const mainFunction = findMainFunction(ast);

    assert(mainFunction !== undefined, `${filename}: unable to find main function.`);

    const [moduleObject, __nop__, main] = mainFunction.args;

    assert(moduleObject instanceof uglifyES.AST_Object, `${filename}: first argument should be an object.`);

    const moduleNames = extractModuleNames(moduleObject, main);
    const modules = extractModules(moduleObject, moduleNames);

    Promise.all(
        Object.keys(modules)
        .map(module => [module, modules[module]])
        .map(([moduleName, module]) => {
            decompress(module);

            const moduleFile = path.join(outputDirectory, moduleName + '.js');
            console.log('Writing %s', moduleFile);

            return outputCode(module, moduleFile);
        })
    );
});

module.exports = {
    outputCode,
    findMainFunction,
    extractModuleNames,
    extractModules,
    unbrowserify
};
