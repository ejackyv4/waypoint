/**
 * Standard supervision conditions, as a starting point.
 *
 * An officer should not retype boilerplate for every agreement — but every
 * clause stays editable, because jurisdictions word these differently and
 * the text is the legally operative part.
 *
 * `suggests` marks a clause that typically produces something actionable.
 * The officer decides whether it actually becomes an obligation; the
 * platform only points out that it might.
 */
export const CONDITION_TEMPLATES = {
  reporting: [
    { body: "Report to your supervising officer as directed and follow all instructions given.",
      suggests: "Report as directed" },
    { body: "Notify your officer within 24 hours if you are unable to attend a scheduled appointment." },
    { body: "Submit a written monthly report by the 5th day of each month.",
      suggests: "Monthly written report" }
  ],
  residence: [
    { body: "Reside at the address approved by your supervising officer." },
    { body: "Obtain permission before changing your residence, and report any change within 72 hours." },
    { body: "Permit your supervising officer to visit your residence." }
  ],
  employment: [
    { body: "Maintain lawful employment, or actively seek employment, or attend an approved education or training program.",
      suggests: "Maintain or seek employment" },
    { body: "Report any change in employment to your supervising officer within 72 hours." },
    { body: "Provide verification of employment when requested." }
  ],
  travel: [
    { body: "Remain within the jurisdiction unless granted written permission to travel." },
    { body: "Obtain a travel permit before any interstate travel." },
    { body: "Comply with any curfew imposed as a condition of supervision." }
  ],
  conduct: [
    { body: "Obey all federal, state and local laws." },
    { body: "Report any arrest, citation or contact with law enforcement within 24 hours." },
    { body: "Do not associate with any person engaged in criminal activity, or with any person specified by your supervising officer." }
  ],
  substance: [
    { body: "Do not unlawfully possess, use or distribute any controlled substance." },
    { body: "Submit to substance testing at the direction of your supervising officer.",
      suggests: "Substance testing" },
    { body: "Abstain from the use of alcohol." }
  ],
  weapons: [
    { body: "Do not possess, own or have access to any firearm, ammunition or destructive device." },
    { body: "Do not possess any dangerous weapon." }
  ],
  programs: [
    { body: "Participate in and complete any treatment, counselling or educational program as directed.",
      suggests: "Complete required program" },
    { body: "Attend all scheduled sessions and comply with all program rules." },
    { body: "Provide documentation of program completion." }
  ],
  financial: [
    { body: "Pay supervision fees as assessed.", suggests: "Supervision fees" },
    { body: "Pay all restitution, fines and court costs in accordance with the payment schedule.",
      suggests: "Restitution and court costs" },
    { body: "Notify your supervising officer of any significant change in financial circumstances." }
  ],
  monitoring: [
    { body: "Submit your person, residence, vehicle and property to search at the direction of your supervising officer." },
    { body: "Comply with electronic monitoring requirements, including keeping any device charged and functional." }
  ],
  contact: [
    { body: "Have no contact, direct or indirect, with the victim or the victim's family." },
    { body: "Have no contact with any co-defendant." }
  ],
  documentation: [
    { body: "Provide valid photo identification to your supervising officer." },
    { body: "Provide proof of residence when requested." },
    { body: "Provide verification of employment, education or program attendance when requested." }
  ],
  special: []
};

export const DEFAULT_VIOLATION_TEXT =
  "Failure to comply with any condition of supervision may result in sanctions, "
+ "modification of the conditions of supervision, or the initiation of revocation "
+ "proceedings. You have the right to be heard in any such proceeding.";
