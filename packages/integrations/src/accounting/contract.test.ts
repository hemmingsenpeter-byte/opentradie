import { describeAccountingContract, fakeHarness, xeroHarness } from './contract-suite.js';

describeAccountingContract([
  ['FakeAccountingAdapter (mock)', () => fakeHarness()],
  ['XeroAccountingAdapter with fake SDK', xeroHarness],
]);
