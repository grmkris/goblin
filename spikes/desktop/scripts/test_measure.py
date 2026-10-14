import unittest
from measure import cpu_seconds, parse_ps, sample_row, summary


def rows():
    return parse_ps('''10 1 100 00:01.50 Wed Oct 14 12:00:00 2026
20 10 200 00:02.00 Wed Oct 14 12:00:00 2026
30 1 300 00:00.50 Wed Oct 14 12:00:00 2026
''')


class AccountingTests(unittest.TestCase):
    def sample(self, current, previous=None, helper_pids=()):
        baseline = rows()
        return sample_row(current, previous or baseline, 10, 20, helper_pids,
                          {pid: row['started'] for pid, row in baseline.items()}, 1)

    def test_overlap_and_explicit_reparented_helper_are_counted_once(self):
        result = self.sample(rows(), helper_pids=[30, 20])
        self.assertEqual(result['total_rss_kib'], 600)
        self.assertEqual(result['process_count'], 3)
        self.assertEqual(result['overlap_pids_deduplicated'], [20])

    def test_dead_or_reused_root_is_missing_not_zero_memory(self):
        current = rows()
        del current[20]
        self.assertIsNone(self.sample(current)['total_rss_kib'])
        self.assertIsNone(self.sample(current)['cpu_percent_one_core'])
        current = rows()
        current[10]['started'] = 'Wed Oct 14 13:00:00 2026'
        self.assertIsNone(self.sample(current)['total_rss_kib'])

    def test_cpu_delta_and_churn(self):
        current = rows()
        current[10]['cpu_seconds'] += .5
        current[20]['cpu_seconds'] += .25
        self.assertEqual(self.sample(current)['cpu_percent_one_core'], 75)
        current[30]['ppid'] = 10
        self.assertIsNone(self.sample(current)['cpu_percent_one_core'])

    def test_ps_formats_and_missing_summary(self):
        self.assertEqual(cpu_seconds('01:02:03'), 3723)
        self.assertEqual(cpu_seconds('1-01:02:03.50'), 90123.5)
        self.assertEqual(cpu_seconds('12:03.25'), 723.25)
        self.assertIsNone(summary([None])['median'])
        self.assertEqual(summary([1, 2, 3, None])['count'], 3)
        self.assertEqual(summary([1, 2, 3])['p95'], 3)


if __name__ == '__main__':
    unittest.main()
