const fs: typeof import("fs") = require("fs");
const path: typeof import("path") = require("path");
const del: typeof import("del") = require("del");

interface ExecResult {
    stdout: Buffer;
    stderr: Buffer;
    status: number;
}

interface UserConfig {
    types: string[];
    path?: string;
}

abstract class ExternalCompileRunnerBase extends RunnerBase {
    abstract testDir: string;
    abstract report(result: ExecResult, cwd: string): string | null;
    enumerateTestFiles() {
        return Harness.IO.getDirectories(this.testDir);
    }
    /** Setup the runner's tests so that they are ready to be executed by the harness
     *  The first test should be a describe/it block that sets up the harness's compiler instance appropriately
     */
    initializeTests(): void {
        // Read in and evaluate the test list
        const testList = this.tests && this.tests.length ? this.tests : this.enumerateTestFiles();

        // tslint:disable-next-line:no-this-assignment
        const cls = this;
        describe(`${this.kind()} code samples`, function(this: Mocha.ISuiteCallbackContext) {
            this.timeout(600_000); // 10 minutes
            for (const test of testList) {
                cls.runTest(typeof test === "string" ? test : test.file);
            }
        });
    }
    private runTest(directoryName: string) {
        // tslint:disable-next-line:no-this-assignment
        const cls = this;
        const timeout = 600_000; // 10 minutes
        describe(directoryName, function(this: Mocha.ISuiteCallbackContext) {
            this.timeout(timeout);
            const cp: typeof import("child_process") = require("child_process");

            it("should build successfully", () => {
                let cwd = path.join(Harness.IO.getWorkspaceRoot(), cls.testDir, directoryName);
                const originalCwd = cwd;
                const stdio = isWorker ? "pipe" : "inherit";
                let types: string[] | undefined;
                if (fs.existsSync(path.join(cwd, "test.json"))) {
                    const submoduleDir = path.join(cwd, directoryName);
                    exec("git", ["reset", "HEAD", "--hard"], { cwd: submoduleDir });
                    exec("git", ["clean", "-f"], { cwd: submoduleDir });
                    exec("git", ["submodule", "update", "--init", "--remote", "."], { cwd: submoduleDir });

                    const config = JSON.parse(fs.readFileSync(path.join(cwd, "test.json"), { encoding: "utf8" })) as UserConfig;
                    ts.Debug.assert(!!config.types, "Bad format from test.json: Types field must be present.");
                    types = config.types;

                    cwd = config.path ? path.join(cwd, config.path) : submoduleDir;
                }
                if (fs.existsSync(path.join(cwd, "package.json"))) {
                    if (fs.existsSync(path.join(cwd, "package-lock.json"))) {
                        fs.unlinkSync(path.join(cwd, "package-lock.json"));
                    }
                    if (fs.existsSync(path.join(cwd, "node_modules"))) {
                        del.sync(path.join(cwd, "node_modules"), { force: true });
                    }
                    exec("npm", ["i", "--ignore-scripts"], { cwd, timeout: timeout / 2 }); // NPM shouldn't take the entire timeout - if it takes a long time, it should be terminated and we should log the failure
                }
                const args = [path.join(Harness.IO.getWorkspaceRoot(), "built/local/tsc.js")];
                if (types) {
                    args.push("--types", types.join(","));
                    // Also actually install those types (for, eg, the js projects which need node)
                    exec("npm", ["i", ...types.map(t => `@types/${t}`), "--no-save", "--ignore-scripts"], { cwd: originalCwd, timeout: timeout / 2 }); // NPM shouldn't take the entire timeout - if it takes a long time, it should be terminated and we should log the failure
                }
                args.push("--noEmit");
                Harness.Baseline.runBaseline(`${cls.kind()}/${directoryName}.log`, cls.report(cp.spawnSync(`node`, args, { cwd, timeout, shell: true }), cwd));

                function exec(command: string, args: string[], options: { cwd: string, timeout?: number }): void {
                    const res = cp.spawnSync(command, args, { timeout, shell: true, stdio, ...options });
                    if (res.status !== 0) {
                        throw new Error(`${command} ${args.join(" ")} for ${directoryName} failed: ${res.stderr && res.stderr.toString()}`);
                    }
                }
            });
        });
    }
}

class UserCodeRunner extends ExternalCompileRunnerBase {
    readonly testDir = "tests/cases/user/";
    kind(): TestRunnerKind {
        return "user";
    }
    report(result: ExecResult) {
        // tslint:disable-next-line:no-null-keyword
        return result.status === 0 && !result.stdout.length && !result.stderr.length ? null : `Exit Code: ${result.status}
Standard output:
${sortErrors(stripAbsoluteImportPaths(result.stdout.toString().replace(/\r\n/g, "\n")))}


Standard error:
${stripAbsoluteImportPaths(result.stderr.toString().replace(/\r\n/g, "\n"))}`;
    }
}

class DockerfileRunner extends ExternalCompileRunnerBase {
    readonly testDir = "tests/cases/docker/";
    kind(): TestRunnerKind {
        return "docker";
    }
    initializeTests(): void {
        // Read in and evaluate the test list
        const testList = this.tests && this.tests.length ? this.tests : this.enumerateTestFiles();

        // tslint:disable-next-line:no-this-assignment
        const cls = this;
        describe(`${this.kind()} code samples`, function(this: Mocha.ISuiteCallbackContext) {
            this.timeout(cls.timeout); // 20 minutes
            before(() => {
                cls.exec("docker", ["build", ".", "-t", "typescript/typescript"], { cwd: Harness.IO.getWorkspaceRoot() }); // cached because workspace is hashed to determine cacheability
            });
            for (const test of testList) {
                const directory = typeof test === "string" ? test : test.file;
                const cwd = path.join(Harness.IO.getWorkspaceRoot(), cls.testDir, directory);
                it(`should build ${directory} successfully`, () => {
                    const imageName = `tstest/${directory}`;
                    cls.exec("docker", ["build", "--no-cache", ".", "-t", imageName], { cwd }); // --no-cache so the latest version of the repos referenced is always fetched
                    const cp: typeof import("child_process") = require("child_process");
                    Harness.Baseline.runBaseline(`${cls.kind()}/${directory}.log`, cls.report(cp.spawnSync(`docker`, ["run", imageName], { cwd, timeout: cls.timeout, shell: true })));
                });
            }
        });
    }

    private timeout = 1_200_000; // 20 minutes;
    private exec(command: string, args: string[], options: { cwd: string, timeout?: number }): void {
        const cp: typeof import("child_process") = require("child_process");
        const stdio = isWorker ? "pipe" : "inherit";
        const res = cp.spawnSync(command, args, { timeout: this.timeout, shell: true, stdio, ...options });
        if (res.status !== 0) {
            throw new Error(`${command} ${args.join(" ")} for ${options.cwd} failed: ${res.stderr && res.stderr.toString()}`);
        }
    }
    report(result: ExecResult) {
        // tslint:disable-next-line:no-null-keyword
        return result.status === 0 && !result.stdout.length && !result.stderr.length ? null : `Exit Code: ${result.status}
Standard output:
${sanitizeDockerfileOutput(result.stdout.toString())}


Standard error:
${sanitizeDockerfileOutput(result.stderr.toString())}`;
    }
}

function sanitizeDockerfileOutput(result: string): string {
    return stripAbsoluteImportPaths(sanitizeTimestamps(stripANSIEscapes(normalizeNewlines(result))));
}

function normalizeNewlines(result: string): string {
    return result.replace(/\r\n/g, "\n");
}

function stripANSIEscapes(result: string): string {
    return result.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function sanitizeTimestamps(result: string): string {
    return result.replace(/\[\d?\d:\d\d:\d\d (A|P)M\]/g, "[XX:XX:XX XM]")
        .replace(/\d+(\.\d+)? seconds?/g, "? seconds")
        .replace(/\d+(\.\d+)? minutes?/g, "")
        .replace(/\d+(\.\d+)?s/g, "?s")
        .replace(/\d+.\d+.\d+-insiders.\d\d\d\d\d\d\d\d/g, "X.X.X-insiders.xxxxxxxx");
}


/**
 * Import types and some other error messages use absolute paths in errors as they have no context to be written relative to;
 * This is problematic for error baselines, so we grep for them and strip them out.
 */
function stripAbsoluteImportPaths(result: string) {
    const workspaceRegexp = new RegExp(Harness.IO.getWorkspaceRoot().replace(/\\/g, "\\\\"), "g");
    return result
        .replace(/import\(".*?\/tests\/cases\/user\//g, `import("/`)
        .replace(/Module '".*?\/tests\/cases\/user\//g, `Module '"/`)
        .replace(workspaceRegexp, "../../..");
}

function sortErrors(result: string) {
    return ts.flatten(splitBy(result.split("\n"), s => /^\S+/.test(s)).sort(compareErrorStrings)).join("\n");
}

const errorRegexp = /^(.+\.[tj]sx?)\((\d+),(\d+)\)(: error TS.*)/;
function compareErrorStrings(a: string[], b: string[]) {
    ts.Debug.assertGreaterThanOrEqual(a.length, 1);
    ts.Debug.assertGreaterThanOrEqual(b.length, 1);
    const matchA = a[0].match(errorRegexp);
    if (!matchA) {
        return -1;
    }
    const matchB = b[0].match(errorRegexp);
    if (!matchB) {
        return 1;
    }
    const [, errorFileA, lineNumberStringA, columnNumberStringA, remainderA] = matchA;
    const [, errorFileB, lineNumberStringB, columnNumberStringB, remainderB] = matchB;
    return ts.comparePathsCaseSensitive(errorFileA, errorFileB) ||
        ts.compareValues(parseInt(lineNumberStringA), parseInt(lineNumberStringB)) ||
        ts.compareValues(parseInt(columnNumberStringA), parseInt(columnNumberStringB)) ||
        ts.compareStringsCaseSensitive(remainderA, remainderB) ||
        ts.compareStringsCaseSensitive(a.slice(1).join("\n"), b.slice(1).join("\n"));
}

class DefinitelyTypedRunner extends ExternalCompileRunnerBase {
    readonly testDir = "../DefinitelyTyped/types/";
    workingDirectory = this.testDir;
    kind(): TestRunnerKind {
        return "dt";
    }
    report(result: ExecResult, cwd: string) {
        const stdout = removeExpectedErrors(result.stdout.toString(), cwd);
        const stderr = result.stderr.toString();
        // tslint:disable-next-line:no-null-keyword
        return !stdout.length && !stderr.length ? null : `Exit Code: ${result.status}
Standard output:
${stdout.replace(/\r\n/g, "\n")}


Standard error:
${stderr.replace(/\r\n/g, "\n")}`;
    }
}

function removeExpectedErrors(errors: string, cwd: string): string {
    return ts.flatten(splitBy(errors.split("\n"), s => /^\S+/.test(s)).filter(isUnexpectedError(cwd))).join("\n");
}
/**
 * Returns true if the line that caused the error contains '$ExpectError',
 * or if the line before that one contains '$ExpectError'.
 * '$ExpectError' is a marker used in Definitely Typed tests,
 * meaning that the error should not contribute toward our error baslines.
 */
function isUnexpectedError(cwd: string) {
    return (error: string[]) => {
        ts.Debug.assertGreaterThanOrEqual(error.length, 1);
        const match = error[0].match(/(.+\.tsx?)\((\d+),\d+\): error TS/);
        if (!match) {
            return true;
        }
        const [, errorFile, lineNumberString] = match;
        const lines = fs.readFileSync(path.join(cwd, errorFile), { encoding: "utf8" }).split("\n");
        const lineNumber = parseInt(lineNumberString) - 1;
        ts.Debug.assertGreaterThanOrEqual(lineNumber, 0);
        ts.Debug.assertLessThan(lineNumber, lines.length);
        const previousLine = lineNumber - 1 > 0 ? lines[lineNumber - 1] : "";
        return !ts.stringContains(lines[lineNumber], "$ExpectError") && !ts.stringContains(previousLine, "$ExpectError");
    };
}
/**
 * Split an array into multiple arrays whenever `isStart` returns true.
 * @example
 * splitBy([1,2,3,4,5,6], isOdd)
 * ==> [[1, 2], [3, 4], [5, 6]]
 * where
 * const isOdd = n => !!(n % 2)
 */
function splitBy<T>(xs: T[], isStart: (x: T) => boolean): T[][] {
    const result = [];
    let group: T[] = [];
    for (const x of xs) {
        if (isStart(x)) {
            if (group.length) {
                result.push(group);
            }
            group = [x];
        }
        else {
            group.push(x);
        }
    }
    if (group.length) {
        result.push(group);
    }
    return result;
}
