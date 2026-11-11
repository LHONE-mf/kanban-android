import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'pagination_fixture', Path(__file__).resolve().parents[1] / 'tools/create_search_pagination_fixture.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PaginationFixtureTest(unittest.TestCase):
    def test_three_pages_have_stable_order_and_valid_nested_target(self):
        data = module.fixture()
        tasks = data['tasks']
        self.assertEqual(len(tasks), 215)
        self.assertEqual(len({t['id'] for t in tasks}), 215)
        ordered = sorted(tasks, key=lambda t: -t['updatedAt'])
        self.assertEqual([ordered[i]['title'] for i in (0, 100, 200, 214)],
                         ['CI pagination 000', 'CI pagination 100', 'CI pagination 200', 'CI pagination 214'])
        parent = next(t for t in tasks if t['id'] == tasks[-1]['parentId'])
        self.assertEqual(parent['boardId'], tasks[-1]['boardId'])
        self.assertEqual(sum(t['boardId'] == 'B' and t['priority'] == 'high' for t in tasks), 58)
        self.assertTrue(all(not t['files'] and not t.get('reminder') for t in tasks))
