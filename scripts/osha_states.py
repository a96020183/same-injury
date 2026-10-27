"""The one list of OSHA State Plan states this repository uses (osha.gov/stateplans): build_sample.py writes it into the
samples' state_plans table, compose_records.py swaps states within each kind, gen_synthetic.py puts invented plants
only in federal-OSHA states. CT, IL, ME, NJ, NY (and VI) cover public employees only, so private employers there are
under federal OSHA and report to the federal Severe Injury file."""
STATE_PLAN_PRIVATE = ['AK', 'AZ', 'CA', 'HI', 'IN', 'IA', 'KY', 'MD', 'MI', 'MN', 'NV', 'NM', 'NC', 'OR', 'PR', 'SC', 'TN', 'UT', 'VT', 'VA', 'WA', 'WY']
# the 50 states and DC under federal OSHA for private employers
FEDERAL = ['AL', 'AR', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'ID', 'IL', 'KS', 'LA', 'ME', 'MA', 'MS', 'MO', 'MT', 'NE', 'NH', 'NJ', 'NY', 'ND', 'OH', 'OK', 'PA', 'RI', 'SD', 'TX', 'WV', 'WI']
NAME = {'AL': 'ALABAMA', 'AK': 'ALASKA', 'AZ': 'ARIZONA', 'AR': 'ARKANSAS', 'CA': 'CALIFORNIA', 'CO': 'COLORADO', 'CT': 'CONNECTICUT', 'DE': 'DELAWARE',
        'DC': 'DISTRICT OF COLUMBIA', 'FL': 'FLORIDA', 'GA': 'GEORGIA', 'HI': 'HAWAII', 'ID': 'IDAHO', 'IL': 'ILLINOIS', 'IN': 'INDIANA', 'IA': 'IOWA',
        'KS': 'KANSAS', 'KY': 'KENTUCKY', 'LA': 'LOUISIANA', 'ME': 'MAINE', 'MD': 'MARYLAND', 'MA': 'MASSACHUSETTS', 'MI': 'MICHIGAN', 'MN': 'MINNESOTA',
        'MS': 'MISSISSIPPI', 'MO': 'MISSOURI', 'MT': 'MONTANA', 'NE': 'NEBRASKA', 'NV': 'NEVADA', 'NH': 'NEW HAMPSHIRE', 'NJ': 'NEW JERSEY', 'NM': 'NEW MEXICO',
        'NY': 'NEW YORK', 'NC': 'NORTH CAROLINA', 'ND': 'NORTH DAKOTA', 'OH': 'OHIO', 'OK': 'OKLAHOMA', 'OR': 'OREGON', 'PA': 'PENNSYLVANIA', 'RI': 'RHODE ISLAND',
        'SC': 'SOUTH CAROLINA', 'SD': 'SOUTH DAKOTA', 'TN': 'TENNESSEE', 'TX': 'TEXAS', 'UT': 'UTAH', 'VT': 'VERMONT', 'VA': 'VIRGINIA', 'WA': 'WASHINGTON',
        'WV': 'WEST VIRGINIA', 'WI': 'WISCONSIN', 'WY': 'WYOMING', 'PR': 'PUERTO RICO'}
