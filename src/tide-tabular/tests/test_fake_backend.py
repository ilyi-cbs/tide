from tabular.domain.models import ClassProbas, ColumnSpec, OutputSpec, Points, QuantileGrid
from tabular.infrastructure.backends.fake import FakeBackend

COLS = (ColumnSpec("a", "numeric"),)


def _call(**kwargs):
    return FakeBackend().fit_predict(
        columns=COLS, x_train=[[1], [2], [3]], x_test=[[4], [5]], timeout_s=30, **kwargs
    )


def test_classification_picks_majority():
    output = _call(task="classification", y_train=["yes", "no", "yes"], output=OutputSpec("probas"))
    assert isinstance(output, ClassProbas)
    assert output.classes == ("no", "yes")
    for scores in output.scores:
        assert scores[output.classes.index("yes")] == 0.9


def test_regression_returns_mean():
    output = _call(task="regression", y_train=[1.0, 2.0, 3.0], output=OutputSpec("point"))
    assert isinstance(output, Points)
    assert output.points == (2.0, 2.0)


def test_quantiles_are_the_empirical_quantiles():
    output = _call(
        task="regression", y_train=[10.0, 20.0, 30.0], output=OutputSpec("quantiles", (0.1, 0.5))
    )
    assert isinstance(output, QuantileGrid)
    assert output.values == ((12.0, 20.0), (12.0, 20.0))
