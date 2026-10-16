// Sorts last but is needed first: Apple's top-level code reads ZEBRA_ROLES as it loads.
var ZEBRA_ROLES = ['Management', 'ERP Admin'];
function whoCanApprove() { return ZEBRA_ROLES; }
