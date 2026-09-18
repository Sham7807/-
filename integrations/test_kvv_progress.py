"""Offline regression checks for official pytest outcome preservation."""
from types import SimpleNamespace
from unittest.mock import patch
import unittest

import kvv_progress
import kvv_runner


class ProgressTests(unittest.TestCase):
    def test_teardown_failure_replaces_pass_without_double_counting(self):
        events = []
        with patch.object(kvv_progress, 'event', events.append):
            for phase, status, detail in [('call', 'passed', ''), ('teardown', 'failed', 'cleanup failed')]:
                kvv_progress.pytest_runtest_logreport(SimpleNamespace(
                    when=phase, outcome=status, longrepr=detail, nodeid='case', duration=.1))
        cases = []
        for event in events:
            kvv_runner.merge_case(cases, event)
        self.assertEqual(len(cases), 1)
        self.assertEqual(cases[0]['status'], 'failed')
        self.assertEqual(cases[0]['phase'], 'teardown')
        self.assertIn('cleanup failed', cases[0]['detail'])
        self.assertEqual(len(cases[0]['phases']), 2)

    def test_both_call_and_teardown_evidence_survive(self):
        cases = []
        for phase in ('call', 'teardown'):
            kvv_runner.merge_case(cases, {'id':'case', 'status':'failed', 'phase':phase, 'detail':phase+' failure'})
        self.assertIn('call failure', cases[0]['detail'])
        self.assertIn('teardown failure', cases[0]['detail'])
        kvv_runner.classify_cases(cases, {'requests':[{'case_id':'case', 'http_status':429, 'infrastructure_error':True}]})
        self.assertEqual(cases[0]['status'], 'failed', 'teardown errors must remain visible')

    def test_observed_token_assertion_not_downgraded_on_early_close(self):
        for reason in ('recorder_closed', 'client_closed'):
            cases = [{'id':'case', 'status':'failed', 'detail':'86 not in [99, 102]'}]
            kvv_runner.classify_cases(cases, {'requests':[{'case_id':'case', 'http_status':200,
                'termination':reason, 'infrastructure_error':True, 'request_id':'r1'}]})
            self.assertEqual(cases[0]['status'], 'failed')
            self.assertEqual(cases[0]['pytest_status'], 'failed')

    def test_infrastructure_failure_stays_inconclusive_and_idempotent(self):
        cases = [{'id':'case', 'status':'failed', 'detail':'provider unavailable'}]
        transport = {'requests':[{'case_id':'case', 'http_status':429, 'infrastructure_error':True}]}
        kvv_runner.classify_cases(cases, transport)
        kvv_runner.classify_cases(cases, transport)
        self.assertEqual(cases[0]['status'], 'inconclusive')
        self.assertEqual(cases[0]['pytest_status'], 'failed')
        self.assertEqual(cases[0]['detail'].count('渠道调用失败'), 1)


if __name__ == '__main__':
    unittest.main()
