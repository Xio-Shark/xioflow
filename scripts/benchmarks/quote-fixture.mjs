import { createQuoteFixture, perturbQuoteFixture } from '../../dist/testing/quote-fixture.js';
import { quoteOracle, verifyQuoteOutputs } from '../../dist/testing/quote-oracle.js';

const [command, root, scenario, ...extra] = process.argv.slice(2);
if (!root || extra.length || !['init', 'perturb', 'oracle', 'verify'].includes(command)
    || (command === 'perturb' ? !['stable', 'local', 'all', 'again'].includes(scenario) : scenario !== undefined)) {
  throw new Error('Usage: node scripts/benchmarks/quote-fixture.mjs init|oracle|verify ROOT | perturb ROOT stable|local|all|again');
}
let result;
if (command === 'init') { await createQuoteFixture(root); result = { created: root }; }
if (command === 'perturb') result = { changed: await perturbQuoteFixture(root, scenario) };
if (command === 'oracle') result = await quoteOracle(root);
if (command === 'verify') { result = await verifyQuoteOutputs(root); if (!result.matched) process.exitCode = 1; }
console.log(JSON.stringify(result, null, 2));
